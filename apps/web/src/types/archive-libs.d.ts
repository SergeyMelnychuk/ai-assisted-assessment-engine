declare module "tar-stream" {
  import type { Readable } from "node:stream";

  export interface Headers {
    name: string;
    size?: number;
    type?: "file" | "directory" | "symlink" | "link" | string;
  }

  export interface Pack extends Readable {
    entry(header: Headers, body?: string | Buffer, callback?: () => void): void;
    finalize(): void;
  }

  export interface Extract extends Readable {
    on(
      event: "entry",
      listener: (header: Headers, stream: Readable, next: () => void) => void,
    ): this;
    on(event: "finish", listener: () => void): this;
    on(event: "error", listener: (error: Error) => void): this;
  }

  export function pack(): Pack;
  export function extract(): Extract;

  const tar: {
    pack: typeof pack;
    extract: typeof extract;
  };

  export default tar;
}

declare module "yauzl" {
  import type { Readable } from "node:stream";

  export interface Entry {
    fileName: string;
    uncompressedSize: number;
    versionMadeBy?: number;
    externalFileAttributes?: number;
  }

  export interface ZipFile {
    once(event: "entry", listener: (entry: Entry) => void): this;
    once(event: "end", listener: () => void): this;
    once(event: "error", listener: (error: Error) => void): this;
    readEntry(): void;
    openReadStream(
      entry: Entry,
      callback: (error: Error | null, stream: Readable | null) => void,
    ): void;
    close(): void;
  }

  export function fromBuffer(
    buffer: Buffer,
    options: { lazyEntries?: boolean },
    callback: (error: Error | null, zipFile: ZipFile | null) => void,
  ): void;

  const yauzl: {
    fromBuffer: typeof fromBuffer;
  };

  export default yauzl;
}
