'use strict';

describe('mobile2NotificationService', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('listNotifications exposes popup-ready fields for existing inbox rows', async () => {
    const query = jest.fn().mockResolvedValue([
      [
        {
          push_id: 44,
          push_title: 'DELIVERY DRIVER ARRIVED',
          push_message: 'Our rider is near your location.',
          push_type: 'driver_arrived',
          date_created: '2026-04-22T01:23:45.000Z',
          is_read: 0,
          json_response: JSON.stringify({
            order_id: 9001,
            task_id: 321,
            show_popup: 1,
            popup_title: 'DELIVERY DRIVER ARRIVED',
            popup_message: 'Our rider is near your location.',
          }),
        },
      ],
    ]);

    jest.doMock('../config/db', () => ({
      pool: { query },
    }));

    const service = require('../services/mobile2NotificationService');
    const items = await service.listNotifications(7, { limit: 10, offset: 0 });

    expect(query).toHaveBeenCalledTimes(1);
    expect(items).toEqual([
      expect.objectContaining({
        push_id: 44,
        order_id: 9001,
        task_id: 321,
        show_popup: 1,
        popup_title: 'DELIVERY DRIVER ARRIVED',
        popup_message: 'Our rider is near your location.',
        popup_type: 'driver_arrived',
      }),
    ]);
  });

  test('listNotificationFeed returns ascending popup items after a cursor', async () => {
    const query = jest.fn().mockResolvedValue([
      [
        {
          push_id: 11,
          push_title: 'DELIVERY DRIVER STARTED',
          push_message: 'Our rider has picked up your food.',
          push_type: 'driver_started',
          date_created: '2026-04-22T02:00:00.000Z',
          is_read: 0,
          json_response: JSON.stringify({
            order_id: 555,
            task_id: 101,
          }),
        },
        {
          push_id: 12,
          push_title: 'DELIVERY IN PROGRESS',
          push_message: 'Your rider is en route with your order.',
          push_type: 'in_progress',
          date_created: '2026-04-22T02:05:00.000Z',
          is_read: 0,
          json_response: JSON.stringify({
            order_id: 555,
            task_id: 101,
            popup_type: 'customer_popup',
          }),
        },
      ],
    ]);

    jest.doMock('../config/db', () => ({
      pool: { query },
    }));

    const service = require('../services/mobile2NotificationService');
    const feed = await service.listNotificationFeed(7, { limit: 2, after_push_id: 10 });

    expect(query).toHaveBeenCalledWith(expect.stringContaining('AND l.id > ?'), [7, 10, 2]);
    expect(feed.cursor).toBe(12);
    expect(feed.after_push_id).toBe(10);
    expect(feed.items.map((item) => item.push_id)).toEqual([11, 12]);
    expect(feed.items[0]).toEqual(
      expect.objectContaining({
        show_popup: 1,
        popup_title: 'DELIVERY DRIVER STARTED',
        popup_message: 'Our rider has picked up your food.',
        popup_type: 'driver_started',
      })
    );
    expect(feed.items[1]).toEqual(
      expect.objectContaining({
        popup_type: 'customer_popup',
      })
    );
  });
});
