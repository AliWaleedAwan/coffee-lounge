import { describe, expect, it } from 'vitest';
import { detectQueues, parseQueues } from '../../src/modules/printing/detect.ts';

describe('finding the Windows print queues (step 8.6)', () => {
  const one = { Name: 'SNC-101', DriverName: 'Generic / Text Only', PortName: 'USB001' };

  it('reads one printer, several, or none', () => {
    const queue = { name: 'SNC-101', driver: 'Generic / Text Only', port: 'USB001' };
    expect(parseQueues(JSON.stringify(one))).toEqual([queue]);
    expect(parseQueues(JSON.stringify([one, { ...one, Name: 'Other' }]))).toHaveLength(2);
    expect(parseQueues(' \r\n')).toEqual([]);
  });

  it('skips an entry with no name', () => {
    expect(parseQueues(JSON.stringify([{ DriverName: 'x' }, null]))).toEqual([]);
  });

  it('says what happened when Windows will not answer, or the answer is garbage', async () => {
    const refused = await detectQueues(() => Promise.reject(new Error('denied')));
    expect(refused).toMatchObject({ supported: true, queues: [] });
    expect(refused).toHaveProperty('problem');
    expect(await detectQueues(() => Promise.resolve('not json'))).toHaveProperty('problem');
  });

  it('is not offered away from Windows', async () => {
    expect(await detectQueues(undefined, 'linux')).toEqual({ supported: false, queues: [] });
  });
});
