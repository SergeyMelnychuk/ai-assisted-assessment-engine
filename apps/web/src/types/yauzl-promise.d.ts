declare module "yauzl-promise" {
  import type { Readable } from "node:stream";

  export interface Entry {
    filename: string;
    openReadStream(): Promise<Readable>;
  }

  export interface ZipFile extends AsyncIterable<Entry> {
    close(): Promise<void>;
  }

  export function fromBuffer(buf: Buffer): Promise<ZipFile>;
}
