/**
 * A local test mail server (Phase 6 step 6.6: no internet in tests). STARTTLS with a
 * certificate from a test authority the fixture trusts, a user name and password, and
 * scripted answers: the next messages can be refused with a temporary (451) or permanent
 * (550) error. It keeps every message it accepted, raw, for the tests to read.
 */
import { SMTPServer } from 'smtp-server';
import { createRootCa, issueServerCertificate } from '../../src/platform/x509.ts';

export interface Received {
  from: string;
  to: string[];
  raw: string;
}

export interface TestMailServer {
  port: number;
  /** For the fixture: trust the test authority (STARTTLS is required). */
  tls: { ca: string };
  user: string;
  password: string;
  received: Received[];
  /** Refuse the next `count` messages with this SMTP code (451 temporary, 550 permanent). */
  refuseNext(count: number, code: 451 | 550): void;
  /** Stops listening (as when the internet is down); `listen` starts again on the same port. */
  stop(): Promise<void>;
  listen(): Promise<void>;
}

export function header(raw: string, name: string): string | null {
  const m = new RegExp(`^${name}:\\s*(.+)$`, 'im').exec(raw);
  return m?.[1]?.trim() ?? null;
}

export async function startMailServer(port = 0): Promise<TestMailServer> {
  const passphrase = 'test-mail-ca';
  const ca = createRootCa({ commonName: 'Test mail CA', passphrase });
  const leaf = issueServerCertificate({
    caCertificatePem: ca.certificatePem,
    caPrivateKeyPem: ca.privateKeyPem,
    caPassphrase: passphrase,
    ips: ['127.0.0.1'],
    days: 30,
  });
  const user = 'shop@example.test';
  const password = `app-${crypto.randomUUID()}`;
  const received: Received[] = [];
  let refusals: { count: number; code: number } = { count: 0, code: 451 };
  let server: SMTPServer | null = null;
  let boundPort = port;

  const make = () =>
    new SMTPServer({
      key: leaf.privateKeyPem,
      cert: leaf.certificatePem,
      authMethods: ['PLAIN', 'LOGIN'],
      logger: false,
      onAuth(auth, _session, callback) {
        if (auth.username === user && auth.password === password) callback(null, { user });
        else callback(Object.assign(new Error('Invalid credentials'), { responseCode: 535 }));
      },
      onData(stream, session, callback) {
        const chunks: Buffer[] = [];
        stream.on('data', (c: Buffer) => chunks.push(c));
        stream.on('end', () => {
          if (refusals.count > 0) {
            refusals = { ...refusals, count: refusals.count - 1 };
            const text = refusals.code === 451 ? 'Try again later' : 'No such mailbox';
            callback(Object.assign(new Error(text), { responseCode: refusals.code }));
            return;
          }
          received.push({
            from: session.envelope.mailFrom ? session.envelope.mailFrom.address : '',
            to: session.envelope.rcptTo.map((r) => r.address),
            raw: Buffer.concat(chunks).toString('utf8'),
          });
          callback();
        });
      },
    });

  const listen = async () => {
    server = make();
    await new Promise<void>((resolve, reject) => {
      server?.once('error', reject);
      server?.listen(boundPort, '127.0.0.1', () => {
        resolve();
      });
    });
    const address = (
      server as unknown as { server: { address(): { port: number } } }
    ).server.address();
    boundPort = address.port;
  };
  await listen();
  return {
    get port() {
      return boundPort;
    },
    tls: { ca: ca.certificatePem },
    user,
    password,
    received,
    refuseNext(count, code) {
      refusals = { count, code };
    },
    stop: () =>
      new Promise<void>((resolve) => {
        if (!server) {
          resolve();
          return;
        }
        server.close(() => {
          resolve();
        });
        server = null;
      }),
    listen,
  };
}
