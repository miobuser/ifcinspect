// Type shim for Vite's `?raw` query suffix on .py / .yaml files.
declare module "*.py?raw" {
  const src: string;
  export default src;
}
declare module "*.yaml?raw" {
  const src: string;
  export default src;
}
declare module "*?url" {
  const url: string;
  export default url;
}
