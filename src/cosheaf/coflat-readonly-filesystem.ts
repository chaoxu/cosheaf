import type { FileEntry, FileSystem } from "@chaoxu/coflat/reader";

// Shared scaffold for the read-only Coflat host FileSystem used by both the
// reader DocumentContext and the page editor: an empty listTree, six write
// methods that reject, and a default `exists` of false. Callers supply the read
// side (readFile/readFileBinary/resolveAssetUrl) and may override `exists` by
// spreading the result (the editor probes the repo; the reader context does
// not). `writeRejection` keeps each surface's original throw message.
interface ReadonlyFileSystemOptions {
  readFile: FileSystem["readFile"];
  readFileBinary: FileSystem["readFileBinary"];
  resolveAssetUrl: FileSystem["resolveAssetUrl"];
  writeRejection?: string;
}

export function readonlyFileSystemBase(options: ReadonlyFileSystemOptions): FileSystem {
  const rejectWrite = async (): Promise<void> => {
    throw new Error(options.writeRejection ?? "Reader context is read-only.");
  };
  return {
    listTree: async (): Promise<FileEntry> => ({ name: "", path: "", isDirectory: true, children: [] }),
    readFile: options.readFile,
    writeFile: rejectWrite,
    createFile: rejectWrite,
    exists: async () => false,
    renameFile: rejectWrite,
    createDirectory: rejectWrite,
    deleteFile: rejectWrite,
    writeFileBinary: rejectWrite,
    readFileBinary: options.readFileBinary,
    resolveAssetUrl: options.resolveAssetUrl,
  };
}
