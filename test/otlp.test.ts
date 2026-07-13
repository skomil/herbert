import { describe, expect, it } from 'vitest';
import { parseLogs, parseMetrics } from '../src/otlp.js';

const attr = (key: string, stringValue: string) => ({ key, value: { stringValue } });

function metricsPayload(temporality: number) {
  return {
    resourceMetrics: [
      {
        resource: { attributes: [attr('service.name', 'claude-code')] },
        scopeMetrics: [
          {
            metrics: [
              {
                name: 'claude_code.token.usage',
                sum: {
                  aggregationTemporality: temporality,
                  dataPoints: [
                    {
                      startTimeUnixNano: '1000000000',
                      timeUnixNano: '2000000000',
                      asInt: '150',
                      attributes: [attr('session.id', 'abc'), attr('type', 'input')],
                    },
                  ],
                },
              },
              {
                name: 'claude_code.cost.usage',
                sum: {
                  aggregationTemporality: temporality,
                  dataPoints: [
                    {
                      timeUnixNano: '2000000000',
                      asDouble: 0.25,
                      attributes: [attr('session.id', 'abc')],
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

describe('parseMetrics', () => {
  it('parses delta sums with merged resource and datapoint attributes', () => {
    const records = parseMetrics(metricsPayload(1));
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      kind: 'metric',
      name: 'claude_code.token.usage',
      value: 150,
      temporality: 'delta',
      attrs: { 'service.name': 'claude-code', 'session.id': 'abc', type: 'input' },
    });
    expect(records[0].t).toBe(2000);
  });

  it('marks non-delta sums as cumulative and keeps start time', () => {
    const records = parseMetrics(metricsPayload(2));
    expect(records[0].temporality).toBe('cumulative');
    expect(records[0].start).toBe('1000000000');
    expect(records[1].value).toBe(0.25);
  });

  it('returns empty for junk payloads', () => {
    expect(parseMetrics({})).toEqual([]);
    expect(parseMetrics({ resourceMetrics: [{}] })).toEqual([]);
  });
});

describe('parseLogs', () => {
  it('parses log records into events, stripping the claude_code prefix', () => {
    const records = parseLogs({
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: '3000000000',
                  body: { stringValue: 'claude_code.tool_result' },
                  attributes: [
                    attr('event.name', 'claude_code.tool_result'),
                    attr('session.id', 'abc'),
                    attr('tool_name', 'Bash'),
                    attr('success', 'false'),
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      kind: 'event',
      name: 'tool_result',
      attrs: { 'session.id': 'abc', tool_name: 'Bash', success: 'false' },
    });
  });
});
