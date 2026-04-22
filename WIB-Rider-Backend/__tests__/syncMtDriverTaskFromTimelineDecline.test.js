'use strict';

describe('syncMtDriverTaskFromTerminalTimelineHistory', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('does not overwrite a reassigned task back to declined when a later assigned history row exists', async () => {
    const query = jest.fn(async (sql) => {
      const text = String(sql);
      if (/FROM mt_order_history/i.test(text)) {
        return [[
          {
            id: 22,
            status: 'assigned',
            remarks: 'Driver reassigned',
            reason: null,
            notes: null,
            description: null,
            date_created: '2026-04-22T11:24:30.000Z',
          },
        ]];
      }
      if (/SELECT status, order_id, task_description FROM mt_driver_task/i.test(text)) {
        return [[{ status: 'assigned', order_id: 174, task_description: 'Test Order' }]];
      }
      if (/UPDATE mt_driver_task SET status = \?/i.test(text)) {
        return [{ affectedRows: 1 }];
      }
      return [[]];
    });

    const updateMtOrderStatusIfDeliveryComplete = jest.fn().mockResolvedValue(undefined);
    const notifyAllDashboardAdminsFireAndForget = jest.fn();

    jest.doMock('../lib/mtOrderStatusSync', () => ({ updateMtOrderStatusIfDeliveryComplete }));
    jest.doMock('../lib/dashboardRiderNotify', () => ({
      foodTaskNotifyFromStatus: jest.fn(() => ({ title: 'x', message: 'y', type: 'declined' })),
      notifyAllDashboardAdminsFireAndForget,
    }));

    const { syncMtDriverTaskFromTerminalTimelineHistory } = require('../lib/syncMtDriverTaskFromTimelineDecline');
    const out = await syncMtDriverTaskFromTerminalTimelineHistory(
      { query },
      418244,
      { id: 21, status: 'declined', remarks: 'Customer unreachable', date_created: '2026-04-22T11:24:00.000Z' }
    );

    expect(out).toEqual({ updated: false });
    expect(query).not.toHaveBeenCalledWith(expect.stringMatching(/UPDATE mt_driver_task SET status = \?/i), expect.anything());
    expect(updateMtOrderStatusIfDeliveryComplete).not.toHaveBeenCalled();
    expect(notifyAllDashboardAdminsFireAndForget).not.toHaveBeenCalled();
  });

  test('still syncs a fresh terminal timeline row when there is no later reassignment history', async () => {
    const query = jest.fn(async (sql) => {
      const text = String(sql);
      if (/FROM mt_order_history/i.test(text)) {
        return [[]];
      }
      if (/SELECT status, order_id, task_description FROM mt_driver_task/i.test(text)) {
        return [[{ status: 'assigned', order_id: 174, task_description: 'Test Order' }]];
      }
      if (/UPDATE mt_driver_task SET status = \?/i.test(text)) {
        return [{ affectedRows: 1 }];
      }
      return [[]];
    });

    const updateMtOrderStatusIfDeliveryComplete = jest.fn().mockResolvedValue(undefined);
    const notifyAllDashboardAdminsFireAndForget = jest.fn();

    jest.doMock('../lib/mtOrderStatusSync', () => ({ updateMtOrderStatusIfDeliveryComplete }));
    jest.doMock('../lib/dashboardRiderNotify', () => ({
      foodTaskNotifyFromStatus: jest.fn(() => ({ title: 'x', message: 'y', type: 'declined' })),
      notifyAllDashboardAdminsFireAndForget,
    }));

    const { syncMtDriverTaskFromTerminalTimelineHistory } = require('../lib/syncMtDriverTaskFromTimelineDecline');
    const out = await syncMtDriverTaskFromTerminalTimelineHistory(
      { query },
      418244,
      { id: 21, status: 'declined', remarks: 'Customer unreachable', date_created: '2026-04-22T11:24:00.000Z' }
    );

    expect(out).toEqual({ updated: true, status: 'declined' });
    expect(query).toHaveBeenCalledWith(
      expect.stringMatching(/UPDATE mt_driver_task SET status = \?, date_modified = NOW\(\) WHERE task_id = \?/i),
      ['declined', 418244]
    );
    expect(updateMtOrderStatusIfDeliveryComplete).toHaveBeenCalledWith({ query }, 174, 'declined');
    expect(notifyAllDashboardAdminsFireAndForget).toHaveBeenCalled();
  });
});
