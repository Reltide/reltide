import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const filesIn = async (root, relative = "") => {
  const directory = path.join(root, relative);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const files = await Promise.all(
    entries.map((entry) => {
      const name = path.posix.join(relative, entry.name);
      return entry.isDirectory()
        ? filesIn(root, name)
        : Promise.resolve([name]);
    })
  );
  return files.flat().toSorted();
};

export const compareArtifactTrees = async (left, right) => {
  const paths = new Set([...(await filesIn(left)), ...(await filesIn(right))]);
  const differences = await Promise.all(
    [...paths].toSorted().map(async (relative) => {
      const [leftFile, rightFile] = await Promise.all(
        [left, right].map(async (root) => {
          try {
            return await readFile(path.join(root, relative));
          } catch (error) {
            if (error.code === "ENOENT") {
              return null;
            }
            throw error;
          }
        })
      );
      return !leftFile || !rightFile || !leftFile.equals(rightFile)
        ? [relative]
        : [];
    })
  );
  return differences.flat();
};
