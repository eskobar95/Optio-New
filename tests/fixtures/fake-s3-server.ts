import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeS3 {
  endpoint: string;
  objects: Map<string, Buffer>;
  close(): Promise<void>;
}

async function body(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function xml(res: ServerResponse, status: number, payload: string): void {
  res.writeHead(status, { "content-type": "application/xml" });
  res.end(`<?xml version="1.0" encoding="UTF-8"?>${payload}`);
}

/** Minimal in-process S3 (path-style, single bucket namespace) for exercising S3BlobStore without MinIO. */
export async function startFakeS3(): Promise<FakeS3> {
  const objects = new Map<string, Buffer>();
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const [bucket, ...rest] = decodeURIComponent(url.pathname).replace(/^\//, "").split("/");
    const key = rest.join("/");
    const full = (k: string): string => `${bucket}/${k}`;
    const data = await body(req);

    if (req.method === "PUT" && key) {
      objects.set(full(key), data);
      res.writeHead(200, { etag: '"x"' });
      return void res.end();
    }
    if ((req.method === "GET" || req.method === "HEAD") && key) {
      const found = objects.get(full(key));
      if (!found) {
        res.writeHead(404, { "content-type": "application/xml" });
        return void res.end(
          req.method === "HEAD"
            ? undefined
            : `<?xml version="1.0"?><Error><Code>NoSuchKey</Code><Message>missing</Message></Error>`,
        );
      }
      res.writeHead(200, { "content-length": found.length });
      return void res.end(req.method === "HEAD" ? undefined : found);
    }
    if (req.method === "GET" && url.searchParams.get("list-type") === "2") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const keys = [...objects.keys()]
        .filter((k) => k.startsWith(`${bucket}/`) && k.slice(bucket.length + 1).startsWith(prefix))
        .map((k) => k.slice(bucket.length + 1));
      const contents = keys.map((k) => `<Contents><Key>${k}</Key></Contents>`).join("");
      return xml(
        res,
        200,
        `<ListBucketResult><IsTruncated>false</IsTruncated><KeyCount>${keys.length}</KeyCount>${contents}</ListBucketResult>`,
      );
    }
    if (req.method === "POST" && url.searchParams.has("delete")) {
      for (const match of data.toString().matchAll(/<Key>([^<]+)<\/Key>/g)) {
        objects.delete(full(match[1] as string));
      }
      return xml(res, 200, "<DeleteResult></DeleteResult>");
    }
    if (!key && (req.method === "HEAD" || req.method === "PUT")) {
      res.writeHead(200);
      return void res.end();
    }
    res.writeHead(400);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    objects,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
