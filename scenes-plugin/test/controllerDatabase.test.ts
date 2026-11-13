// Database scenes in the scenes controller (specs/2026-11-13-own-database.md): kept in a connected
// database, never in Drive; new scenes there by the setting; "Move to…" between the homes with a
// moved note; agents' edits of a scene that isn't open go to the database element by element; the
// database's listing adds and drops records. Real controller, in-memory editor, storage, Drive and
// database (./controllerHarness.ts, ./fakeSceneRows.ts).
import { describe, expect, it } from "vitest";

import { controllerHarness, el, flush, sceneJson } from "./controllerHarness";

const REF = "abcdefghijklmnopqrst";

describe("database scenes", () => {
  it("new scenes go to the database by the setting; they are kept there, not in Drive", async () => {
    const { controller, database, drive } = await controllerHarness({ online: true });
    controller.setSignedIn(true);
    controller.setNewScenesHome(`db:${REF}`);
    expect(controller.newScenesHome()).toBe(`db:${REF}`);
    await controller.create("Plan");
    expect(controller.databaseOf("Plan")).toEqual({ ref: REF });
    expect(controller.homeOf("Plan").kind).toBe("database");
    const id = await controller.ensureInDatabase("Plan");
    expect([...database.scenes.values()].map((scene) => [scene.id, scene.name])).toEqual([[id, "Plan"]]);
    const item = controller.getState().list.find((entry: any) => entry.name === "Plan");
    expect(item).toMatchObject({ home: "database", status: "database", localOnly: false, inDrive: false });
    await controller.syncNow({ refresh: true });
    await flush();
    expect(drive.files.has("Plan")).toBe(false); // never pushed to Drive
    // agents: read and edited through the tab
    expect(await controller.flush("Plan")).toMatchObject({ localOnly: true, home: "database" });
    await expect(controller.setLocalOnly("Plan", false)).rejects.toThrow(/Move to/);
  });

  it("Move to…: browser → database → Drive with everything, a moved note on the database's row", async () => {
    const { controller, database, databaseHome, drive } = await controllerHarness({ online: true });
    controller.setSignedIn(true);
    await controller.createLocalOnly("Deck", sceneJson("Deck", [el("a"), el("b")], { viewBackgroundColor: "#fdf6e3" }));
    const fromBrowser = await controller.moveTo("Deck", `db:${REF}`);
    expect(fromBrowser.key).toBe("browser");
    expect(controller.databaseOf("Deck")?.id).toBeTruthy();
    const there = JSON.parse((await databaseHome.load("Deck")).json);
    expect(there.elements.map((item: any) => item.id)).toEqual(["a", "b"]);
    expect(there.appState.viewBackgroundColor).toBe("#fdf6e3");

    const fromDb = await controller.moveTo("Deck", "drive");
    expect(fromDb.key).toBe(`db:${REF}`);
    expect(controller.databaseOf("Deck")).toBeNull();
    expect(controller.isLocalOnly("Deck")).toBe(false);
    expect(JSON.parse(drive.files.get("Deck")!.json).elements.map((item: any) => item.id)).toEqual(["a", "b"]);
    const row = [...database.scenes.values()].find((scene) => scene.name === "Deck")!;
    expect(row.moved_to).toMatchObject({ home: "drive" });
    expect((await databaseHome.list()).scenes).toEqual([]); // moved: not listed any more
    // deleting the old copy
    await controller.removeOldCopy(fromDb, "Deck");
    expect(database.scenes.size).toBe(0);
  });

  it("an agent's edit of a database scene that isn't open goes to the database, element by element", async () => {
    const { controller, database, databaseHome } = await controllerHarness({ online: true });
    controller.setNewScenesHome(`db:${REF}`);
    await controller.create("Plan");
    const id = await controller.ensureInDatabase("Plan");
    await controller.open(null);
    // someone else adds an element meanwhile
    await databaseHome.rows.putElements(id, [el("theirs")]);
    const read = JSON.parse(await controller.localOnlyJson("Plan"));
    expect(read.elements.map((item: any) => item.id)).toEqual(["theirs"]);
    await databaseHome.rows.putElements(id, [el("later")]);
    await controller.writeLocalOnly("Plan", sceneJson("Plan", [...read.elements, el("agent")]));
    const rows = [...database.scenes.get(id)!.elements.values()].filter((row) => !row.data.isDeleted).map((row) => row.id);
    expect(rows.sort()).toEqual(["agent", "later", "theirs"]); // "later" (added after the read) stays
  });

  it("the database's listing adds its scenes here and drops those gone from it; rename and delete go there", async () => {
    const { controller, database, databaseHome } = await controllerHarness({ online: true });
    const created = await database.rows.createScene("Shared");
    await controller.refreshDatabases();
    expect(controller.databaseOf("Shared")).toEqual({ ref: REF, id: created.id });
    await controller.rename("Shared", "Shared 2");
    expect((await databaseHome.list()).scenes.map((scene: any) => scene.name)).toEqual(["Shared 2"]);
    await controller.remove("Shared 2");
    expect(database.scenes.size).toBe(0);
    const other = await database.rows.createScene("Gone");
    await controller.refreshDatabases();
    expect(controller.databaseOf("Gone")?.id).toBe(other.id);
    await database.rows.deleteScene(other.id);
    await controller.refreshDatabases();
    expect(controller.databaseOf("Gone")).toBeNull();
  });

  it("a database scene's link: its record by id, a free name if the name is taken here", async () => {
    const { controller } = await controllerHarness({ online: true });
    await controller.createLocalOnly("Plan", sceneJson("Plan", [el("mine")]));
    const name = await controller.adoptDatabaseScene(REF, "00000000-0000-4000-8000-000000000009", "Plan");
    expect(name).not.toBe("Plan");
    expect(controller.databaseOf(name)).toEqual({ ref: REF, id: "00000000-0000-4000-8000-000000000009" });
    expect(await controller.adoptDatabaseScene(REF, "00000000-0000-4000-8000-000000000009", "Plan")).toBe(name);
  });

  it("the open database scene's access and pending changes show in its state", async () => {
    const { controller } = await controllerHarness({ online: true });
    controller.setNewScenesHome(`db:${REF}`);
    await controller.create("Plan");
    controller.setHomePending("Plan", true);
    expect(controller.statusOf("Plan")).toBe("database-pending");
    expect(controller.pendingCount()).toBe(1);
    controller.setHomePending("Plan", false, 7);
    expect(controller.statusOf("Plan")).toBe("database");
    expect(controller.databaseOf("Plan")?.rev).toBe(7);
    controller.setHomeAccess({ readOnly: "You can view this scene, not change it", comment: false });
    expect(controller.canComment()).toBe(false);
    controller.setHomeAccess({ readOnly: "You can comment on this scene, not change it", comment: true });
    expect(controller.canComment()).toBe(true);
  });
});
