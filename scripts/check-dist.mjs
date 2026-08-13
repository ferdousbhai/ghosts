import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const packagesDirectory = join(repositoryRoot, "packages");

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await checkDist();
}

async function checkDist() {
  const beforeBuild = await readDistFiles();
  const build = spawnSync("pnpm", ["build"], {
    cwd: repositoryRoot,
    stdio: "inherit",
  });
  if (build.error) throw build.error;
  if (build.status !== 0) process.exit(build.status ?? 1);

  const generated = await readDistFiles();
  const staged = trackedDistFiles();
  const worktreeProblems = findDistProblems(beforeBuild, generated, staged, {
    compareTrackedContent: false,
  });
  const stagedGenerated = await buildStagedDist();
  const stagedProblems = findDistProblems(staged, stagedGenerated, staged)
    .map((problem) => `index ${problem}`);
  const problems = [...worktreeProblems, ...stagedProblems];
  if (problems.length) {
    process.stderr.write("Generated dist artifacts were stale or are not fully tracked:\n");
    for (const problem of problems) process.stderr.write(`  ${problem}\n`);
    process.exit(1);
  }
}

/** Compare checked-in working artifacts to a clean build without consulting HEAD content. */
export function findDistProblems(
  beforeBuild,
  generated,
  staged,
  options = { compareTrackedContent: true },
) {
  const problems = [];
  for (const path of new Set([...beforeBuild.keys(), ...generated.keys()])) {
    const previous = beforeBuild.get(path);
    const rebuilt = generated.get(path);
    if (!previous) problems.push(`missing before build: ${path}`);
    else if (!rebuilt) problems.push(`stale extra file: ${path}`);
    else if (!previous.equals(rebuilt)) problems.push(`changed by build: ${path}`);
  }

  const generatedPaths = new Set(generated.keys());
  for (const [path, rebuilt] of generated) {
    const stagedContent = staged.get(path);
    if (!stagedContent) problems.push(`untracked: ${path}`);
    else if (options.compareTrackedContent && !stagedContent.equals(rebuilt)) {
      problems.push(`staged content differs: ${path}`);
    }
  }
  for (const path of staged.keys()) {
    if (!generatedPaths.has(path)) problems.push(`not generated: ${path}`);
  }
  return problems.sort();
}

async function readDistFiles(directory = packagesDirectory) {
  const files = new Map();
  const root = resolve(directory, "..");
  const packages = await readdir(directory, { withFileTypes: true });
  await Promise.all(packages.filter((entry) => entry.isDirectory()).map(async (entry) => {
    const distDirectory = join(directory, entry.name, "dist");
    await readDirectory(distDirectory, files, root).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }));
  return files;
}

async function readDirectory(directory, files, root) {
  const entries = await readdir(directory, { withFileTypes: true });
  await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await readDirectory(path, files, root);
    } else if (entry.isFile()) {
      files.set(repositoryPath(path, root), await readFile(path));
    }
  }));
}

async function buildStagedDist() {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "ghosts-check-dist-"));
  try {
    const checkout = spawnSync(
      "git",
      ["checkout-index", "--all", `--prefix=${temporaryRoot}${sep}`],
      { cwd: repositoryRoot, stdio: "inherit" },
    );
    if (checkout.error) throw checkout.error;
    if (checkout.status !== 0) throw new Error("Could not materialize the Git index");

    await symlink(join(repositoryRoot, "node_modules"), join(temporaryRoot, "node_modules"), "dir");
    const packages = await readdir(packagesDirectory, { withFileTypes: true });
    await Promise.all(packages.filter((entry) => entry.isDirectory()).map(async (entry) => {
      const source = join(packagesDirectory, entry.name, "node_modules");
      const target = join(temporaryRoot, "packages", entry.name, "node_modules");
      await symlink(source, target, "dir").catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
      await rm(join(temporaryRoot, "packages", entry.name, "dist"), {
        recursive: true,
        force: true,
      });
    }));

    const build = spawnSync("pnpm", ["--recursive", "build"], {
      cwd: temporaryRoot,
      stdio: "inherit",
    });
    if (build.error) throw build.error;
    if (build.status !== 0) throw new Error("Could not build the Git index");
    return readDistFiles(join(temporaryRoot, "packages"));
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function trackedDistFiles() {
  const result = spawnSync(
    "git",
    ["ls-files", "--cached", "--", ":(glob)packages/*/dist/**"],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }

  return new Map(result.stdout.split("\n").filter(Boolean).map((path) => {
    const content = spawnSync("git", ["show", `:${path}`], {
      cwd: repositoryRoot,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (content.error) throw content.error;
    if (content.status !== 0) {
      process.stderr.write(content.stderr);
      process.exit(content.status ?? 1);
    }
    return [path, content.stdout];
  }));
}

function repositoryPath(path, root = repositoryRoot) {
  return relative(root, path).split(sep).join("/");
}
