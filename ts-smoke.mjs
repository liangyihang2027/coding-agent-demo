import { Parser, Language } from "web-tree-sitter";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
await Parser.init();
const wasmPath = require.resolve("tree-sitter-wasms/out/tree-sitter-typescript.wasm");
const lang = await Language.load(wasmPath);
const parser = new Parser();
parser.setLanguage(lang);
const code = "export class Foo { bar() { return 1; } }\nexport function baz(a){ return a; }\nconst qux = () => 2;";
const tree = parser.parse(code);
console.log("ROOT:", tree.rootNode.type);
function walk(n, d=0){
  if(["class_declaration","function_declaration","method_definition","lexical_declaration","variable_declarator"].includes(n.type)){
    const nameNode = n.childForFieldName ? n.childForFieldName("name") : null;
    console.log("  ".repeat(d), n.type, "=>", nameNode?nameNode.text:"(no name field)", "@", n.startPosition.row);
  }
  for(let i=0;i<n.childCount;i++) walk(n.child(i), d+1);
}
walk(tree.rootNode);
console.log("OK");
