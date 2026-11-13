// A stylesheet as a string (Vite's `?inline`): the presenter window is a
// document of its own and gets the paragraph rules (paragraphs.scss) that way.
declare module "*.scss?inline" {
  const css: string;
  export default css;
}
