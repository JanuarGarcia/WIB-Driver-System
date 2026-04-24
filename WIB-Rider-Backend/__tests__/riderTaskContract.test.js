'use strict';

const {
  shouldIncludeActiveTaskListRow,
  readContractDeliveryAsap,
} = require('../lib/riderTaskContract');

describe('rider task contract helpers', () => {
  test('excludes inactive and unassigned rows from active task refresh responses', () => {
    expect(
      shouldIncludeActiveTaskListRow(
        { driver_id: 9, status: 'started' },
        { driverId: 9 }
      )
    ).toBe(true);

    expect(
      shouldIncludeActiveTaskListRow(
        { driver_id: 9, status_raw: 'successful' },
        { driverId: 9 }
      )
    ).toBe(false);

    expect(
      shouldIncludeActiveTaskListRow(
        { driver_id: 9, status: 'cancelled' },
        { driverId: 9 }
      )
    ).toBe(false);

    expect(
      shouldIncludeActiveTaskListRow(
        { driver_id: null, status: 'assigned' },
        { driverId: 9 }
      )
    ).toBe(false);

    expect(
      shouldIncludeActiveTaskListRow(
        { driver_id: 0, status: 'unassigned' },
        { driverId: 9, includeUnassigned: true }
      )
    ).toBe(true);
  });

  test('normalizes delivery_asap from common backend field variants', () => {
    expect(readContractDeliveryAsap({ delivery_asap: 1 })).toBe(1);
    expect(readContractDeliveryAsap({ is_asap: 'true' })).toBe(1);
    expect(readContractDeliveryAsap({ asap: '0' })).toBe(0);
    expect(readContractDeliveryAsap({})).toBe(0);
  });
});
