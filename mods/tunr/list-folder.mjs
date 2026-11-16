import { readdirSync, statSync } from "node:fs";
import path from "node:path";

const dir = process.argv[2];
if (!dir) process.exit(0);

const out = [];
for (const entry of readdirSync(dir, { withFileTypes: true })) {
  if (entry.isFile()) {
    out.push(entry.name);
  } else if (entry.isSymbolicLink()) {
    try {
      if (statSync(path.join(dir, entry.name)).isFile()) out.push(entry.name);
    } catch {}
  }
}
process.stdout.write(JSON.stringify(out));
