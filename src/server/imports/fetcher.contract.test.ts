import { describe, expect, it } from 'vitest';
import { WhenIsGoodFetcher } from './fetcher.js';

describe('WhenIsGood fetcher', () => {
  it('uses a supplied results URL without appending a query parameter', async () => {
    const html = `
      <script>
        var r100 = new Object();
        r100.id = "100";
        r100.name = "Example Person";
        r100.myCanDos = "1789376400000".split(",");
        r100.included = true;
      </script>`;
    let requestedUrl = '';
    const fetcher = new WhenIsGoodFetcher({
      endpoint: 'https://whenisgood.net/d7y3d5c/results/mx8t23j',
      fetch: (url) => {
        requestedUrl = url;
        return { ok: true, status: 200, text: () => html };
      },
      parserOptions: { defaultTimeZone: 'America/New_York' }
    });

    const result = fetcher.fetchResult('mx8t23j');

    expect(requestedUrl).toBe('https://whenisgood.net/d7y3d5c/results/mx8t23j');
    expect(result.parsed.participants).toHaveLength(1);
  });
});
