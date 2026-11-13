import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { OverleafClient } from '../src/client.js';

interface CapturedRequest {
  method?: string;
  url?: string;
  headers: IncomingMessage['headers'];
  body: string;
}

async function withServer(
  response: { status?: number; body: unknown; headers?: Record<string, string> },
  run: (baseUrl: string, getRequest: () => CapturedRequest | undefined) => Promise<void>
): Promise<void> {
  let request: CapturedRequest | undefined;
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    request = {
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: Buffer.concat(chunks).toString('utf-8')
    };
    res.writeHead(response.status ?? 200, {
      'Content-Type': 'application/json',
      ...response.headers
    });
    res.end(JSON.stringify(response.body));
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');

  try {
    await run(`http://127.0.0.1:${address.port}`, () => request);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  }
}

test('createProject creates a blank project and maps the response', async () => {
  await withServer(
    {
      body: { project_id: '0123456789abcdef01234567', owner_ref: 'owner-id' },
      headers: { 'Set-Cookie': 'refreshed=session; Path=/' }
    },
    async (baseUrl, getRequest) => {
      const client = new OverleafClient({
        cookies: { session: 'secret' },
        csrf: 'csrf-token',
        baseUrl
      });

      const created = await client.createProject('  My Paper  ');

      assert.deepEqual(created, {
        id: '0123456789abcdef01234567',
        name: 'My Paper',
        url: `${baseUrl}/project/0123456789abcdef01234567`,
        ownerId: 'owner-id'
      });
      assert.equal(client.getCookie('refreshed'), 'session');
      assert.deepEqual(JSON.parse(getRequest()?.body ?? ''), { projectName: 'My Paper' });
      assert.equal(getRequest()?.method, 'POST');
      assert.equal(getRequest()?.url, '/project/new');
      assert.equal(getRequest()?.headers['content-type'], 'application/json');
      assert.equal(getRequest()?.headers['x-csrf-token'], 'csrf-token');
    }
  );
});

test('createProject requests the example template', async () => {
  await withServer(
    { body: { project_id: '0123456789abcdef01234567' } },
    async (baseUrl, getRequest) => {
      const client = new OverleafClient({ cookies: {}, csrf: 'csrf-token', baseUrl });
      await client.createProject('Example Paper', { template: 'example' });
      assert.deepEqual(JSON.parse(getRequest()?.body ?? ''), {
        projectName: 'Example Paper',
        template: 'example'
      });
    }
  );
});

test('createProject rejects invalid input before making a request', async () => {
  const client = new OverleafClient({ cookies: {}, csrf: 'csrf-token' });
  await assert.rejects(client.createProject('  '), /Project name must not be empty/);
  await assert.rejects(
    client.createProject('Paper', { template: 'unsupported' as 'blank' }),
    /Unsupported project template: unsupported/
  );
});

test('createProject reports HTTP errors and malformed success responses', async () => {
  await withServer(
    { status: 403, body: { message: 'forbidden' } },
    async baseUrl => {
      const client = new OverleafClient({ cookies: {}, csrf: 'csrf-token', baseUrl });
      await assert.rejects(client.createProject('Paper'), /Failed to create project: 403/);
    }
  );

  await withServer(
    { body: {} },
    async baseUrl => {
      const client = new OverleafClient({ cookies: {}, csrf: 'csrf-token', baseUrl });
      await assert.rejects(client.createProject('Paper'), /response did not include a project ID/);
    }
  );
});

test('listComments joins docs over several sockets, not one doc at a time on one socket', async () => {
  const client: any = new OverleafClient({ cookies: { session: 'secret' }, csrf: 'csrf-token' });
  const docs = Array.from({ length: 10 }, (_, i) => ({ _id: `doc${i}`, name: `f${i}.tex` }));
  client.getProjectInfo = async () => ({ rootFolder: [{ docs, folders: [] }] });
  client.getCommentThreads = async () => ({});

  let open = 0;
  const sessions = new Set<object>();
  const joinedBy = new Map<string, object>();
  client.openProjectSocket = async () => {
    const session = {};
    sessions.add(session);
    open++;
    return session;
  };
  client.closeProjectSocket = async () => { open--; };
  client.joinDocument = async (session: object, docId: string) => {
    joinedBy.set(docId, session);
    await new Promise(resolve => setTimeout(resolve, 5));
    const index = Number(docId.slice(3));
    return {
      docId,
      content: 'hello world',
      lines: ['hello world'],
      version: 1,
      type: 'sharejs-text-ot',
      ranges: index === 7 ? { comments: [{ op: { c: 'world', p: 6, t: 'thread7' } }] } : {}
    };
  };

  const comments = await client.listComments('project');

  assert.equal(joinedBy.size, 10);
  assert(sessions.size > 1 && sessions.size <= 4, `expected 2-4 sockets, got ${sessions.size}`);
  assert.equal(open, 0, 'every socket is closed');
  assert.deepEqual(comments.map((c: any) => [c.threadId, c.path]), [['thread7', 'f7.tex']]);
});

test('httpRequest retries 429 (honoring Retry-After) and gives up after 5 retries', async () => {
  for (const [failures, expectedStatus, expectedCalls] of [[2, 200, 3], [99, 429, 6]] as const) {
    let calls = 0;
    const server = createServer((_req, res) => {
      calls++;
      const limited = calls <= failures;
      res.writeHead(limited ? 429 : 200, { 'Content-Type': 'application/json', ...(limited ? { 'Retry-After': '0' } : {}) });
      res.end('{}');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as { port: number };
      const client = new OverleafClient({ cookies: { session: 's' }, csrf: 'c', baseUrl: `http://127.0.0.1:${port}` });
      const res = await (client as any).httpRequest(`http://127.0.0.1:${port}/x`, { expect: 'json' });
      assert.equal(res.status, expectedStatus);
      assert.equal(calls, expectedCalls);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  }
});

test('listReview returns tracked changes with context and their authors', async () => {
  const client: any = new OverleafClient({ cookies: {}, csrf: 'csrf-token' });
  client.getProjectInfo = async () => ({ rootFolder: [{ docs: [{ _id: 'd1', name: 'main.tex' }], folders: [] }] });
  client.getCommentThreads = async () => ({});
  client.openProjectSocket = async () => ({});
  client.closeProjectSocket = async () => {};
  client.joinDocument = async (_session: object, docId: string) => ({
    docId,
    content: 'as a new thing and more',
    lines: ['as a new thing and more'],
    version: 1,
    type: 'sharejs-text-ot',
    ranges: { changes: [
      { id: 'c2', op: { p: 14, d: 'old' }, metadata: { user_id: 'u1', ts: '2026-11-13T06:42:53.250Z' } },
      { id: 'c1', op: { p: 5, i: 'new thing' }, metadata: { user_id: 'u1', ts: '2026-11-13T06:42:53.250Z' } }
    ] }
  });
  client.getChangeUsers = async () => [{ id: 'u1', first_name: 'Ada', last_name: 'L' }];

  const { comments, changes } = await client.listReview('project');

  assert.deepEqual(comments, []);
  assert.deepEqual(changes.map((c: any) => [c.id, c.kind, c.text, c.position, c.before, c.after, c.user?.first_name]), [
    ['c1', 'insert', 'new thing', 5, 'as a ', ' and more', 'Ada'],
    ['c2', 'delete', 'old', 14, 'as a new thing', ' and more', 'Ada']
  ]);
});

test('acceptChanges posts the change ids with the CSRF token', async () => {
  await withServer({ body: {} }, async (baseUrl, getRequest) => {
    const client = new OverleafClient({ cookies: {}, csrf: 'csrf-token', baseUrl });
    await client.acceptChanges('p1', 'd1', ['c1', 'c2']);
    const req = getRequest();
    assert.equal(req?.method, 'POST');
    assert.equal(req?.url, '/project/p1/doc/d1/changes/accept');
    assert.equal(req?.headers['x-csrf-token'], 'csrf-token');
    assert.deepEqual(JSON.parse(req?.body ?? ''), { change_ids: ['c1', 'c2'] });
  });
});

test('suggestChanges undoes a pushed edit untracked, redoes it tracked, and leaves unpushed edits alone', async () => {
  const client: any = new OverleafClient({ cookies: {}, csrf: 'csrf-token' });
  client.getProjectInfo = async () => ({ rootFolder: [{ docs: [{ _id: 'd1', name: 'main.tex' }], folders: [] }] });
  client.openProjectSocket = async () => ({});
  client.closeProjectSocket = async () => {};
  client.joinDocument = async () => ({ docId: 'd1', content: 'The new cat sat.', lines: [], version: 7, type: 'sharejs-text-ot', ranges: {} });
  const sent: any[] = [];
  client.socketRpc = async (_s: object, name: string, args: any[]) => { sent.push([name, args[1]]); return []; };

  const res = await client.suggestChanges('p', 'main.tex', [
    { before: 'The ', deleted: 'old', inserted: 'new', after: ' cat', hint: 4 },
    { before: 'cat ', deleted: 'sat', inserted: 'ran', after: '.', hint: 12 }
  ]);

  assert.deepEqual(res, ['done', 'not-pushed']);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0][1].op, [{ d: 'new', p: 4 }, { i: 'old', p: 4 }]);
  assert.equal(sent[0][1].meta, undefined);
  assert.deepEqual(sent[1][1].op, [{ d: 'old', p: 4 }, { i: 'new', p: 4 }]);
  assert.match(sent[1][1].meta.tc, /^[0-9a-f]{18}$/);
  assert.deepEqual([sent[0][1].v, sent[1][1].v], [7, 8]);
});
