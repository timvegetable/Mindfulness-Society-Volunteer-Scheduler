import { describe, expect, it } from 'vitest';
import { parseEmbeddedWhenIsGoodData } from './parser.js';

describe('legacy WhenIsGood results parser', () => {
  it('decodes respondent assignments and preserves displayed wall-clock slots', () => {
    const html = `
      <table>
        <td class="slot proposed" id="1789376400000"></td>
        <td class="slot proposed" id="1789380000000"></td>
      </table>
      <script>
        var respondents = new Array();
        var r100 = new Object();
        r100.id = "100";
        r100.name = "Example Person";
        r100.myCanDos = "1789376400000,1789380000000".split(",");
        r100.included = true;
        respondents["r100"] = r100;
      </script>`;

    const parsed = parseEmbeddedWhenIsGoodData(html, {
      resultId: 'legacy-result',
      defaultTimeZone: 'America/New_York'
    });

    expect(parsed).toMatchObject({
      source: 'whenisgood',
      resultId: 'legacy-result',
      participants: [{
        sourceParticipantId: '100',
        name: 'Example Person',
        availability: [
          { date: '2026-09-14', weekday: 1, start: '09:00', end: '10:00' },
          { date: '2026-09-14', weekday: 1, start: '10:00', end: '11:00' }
        ]
      }]
    });
    expect(parsed.timeZone).toBeUndefined();
  });
});
