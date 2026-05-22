// The upstream `@types/pdf-parse` package only declares the top-level
// entry point. We import `pdf-parse/lib/pdf-parse.js` directly to skip
// the library's dev-only filesystem probe that crashes under webpack;
// this stub reuses the public types so the import stays type-safe.
declare module "pdf-parse/lib/pdf-parse.js" {
  import pdfParse from "pdf-parse";
  export default pdfParse;
}
