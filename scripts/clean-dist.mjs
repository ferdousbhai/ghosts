import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const packagesDirectory = fileURLToPath(new URL("../packages", import.meta.url));
const packages = await readdir(packagesDirectory, { withFileTypes: true });

await Promise.all(
  packages
    .filter((entry) => entry.isDirectory())
    .map((entry) => rm(join(packagesDirectory, entry.name, "dist"), { recursive: true, force: true })),
);
