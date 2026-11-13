# tsgo-lsp

Wires Claude Code's built-in `LSP` tool (go-to-definition, find-references, hover,
document/workspace symbols, call hierarchy) to the TypeScript language server that
ships inside this repo's own `typescript` devDependency — TypeScript 7's native
binary, run via `node node_modules/typescript/lib/tsc.js --lsp --stdio`.

Requires `npm install` to have been run. Nothing else: no global tooling, no extra
dependency, same compiler the `typecheck` script uses.

Install (once per machine):

```bash
claude plugin marketplace add .
claude plugin install tsgo-lsp@tttracker
```

Then restart Claude Code.
