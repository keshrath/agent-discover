// =============================================================================
// agent-discover — LogService kind support
// =============================================================================

import { describe, it, expect } from 'vitest';
import { LogService } from '../src/domain/log.js';

describe('LogService kind', () => {
  it('defaults to call kind', () => {
    const svc = new LogService();
    svc.push('srv', 'tool', {}, 'ok', 1, true);
    expect(svc.list()[0].kind).toBe('call');
  });

  it('records notification kind', () => {
    const svc = new LogService();
    svc.pushNotification('srv', 'notifications/message', { text: 'hi' });
    const entry = svc.list()[0];
    expect(entry.kind).toBe('notification');
    expect(entry.tool).toBe('notifications/message');
  });

  it('records progress kind with token/progress', () => {
    const svc = new LogService();
    svc.pushProgress('srv', 'tok-1', 50, 100, 'halfway');
    const entry = svc.list()[0];
    expect(entry.kind).toBe('progress');
    expect(entry.args.token).toBe('tok-1');
    expect(entry.args.progress).toBe(50);
  });

  it('filters list by kind', () => {
    const svc = new LogService();
    svc.push('s', 't', {}, 'r', 1, true);
    svc.pushNotification('s', 'n/m', {});
    svc.pushProgress('s', 1, 10, undefined, undefined);
    expect(svc.list(100, 0, 'call')).toHaveLength(1);
    expect(svc.list(100, 0, 'notification')).toHaveLength(1);
    expect(svc.list(100, 0, 'progress')).toHaveLength(1);
    expect(svc.count('notification')).toBe(1);
    expect(svc.count()).toBe(3);
  });

  it('emits onEntry for all kinds', () => {
    const svc = new LogService();
    const seen: string[] = [];
    svc.onEntry = (e) => seen.push(e.kind);
    svc.push('s', 't', {}, 'r', 1, true);
    svc.pushNotification('s', 'n', {});
    svc.pushProgress('s', 1, 10, undefined, undefined);
    expect(seen).toEqual(['call', 'notification', 'progress']);
  });
});
