const {
  normalizeIncomingStatusRaw,
  normalizeErrandStatusForApp,
  mapDeliveryToCanonicalTaskStatus,
  deriveErrandDriverTaskStatus,
} = require('./lib/errandDriverStatus');

describe('errandDriverStatus', () => {
  test('normalizes legacy Mangan statuses for rider-app responses', () => {
    expect(normalizeErrandStatusForApp('pending')).toBe('assigned');
    expect(normalizeErrandStatusForApp('available')).toBe('assigned');
    expect(normalizeErrandStatusForApp('pending_accept')).toBe('assigned');
    expect(normalizeErrandStatusForApp('pending_pickup')).toBe('acknowledged');
    expect(normalizeErrandStatusForApp('ready_for_pickup')).toBe('acknowledged');
    expect(normalizeErrandStatusForApp('arrivedatvendor')).toBe('started');
    expect(normalizeErrandStatusForApp('picked_up')).toBe('inprogress');
    expect(normalizeErrandStatusForApp('on_the_way_to_customer')).toBe('inprogress');
    expect(normalizeErrandStatusForApp('arrivedatcustomer')).toBe('pending_verification');
    expect(normalizeErrandStatusForApp('orderdelivered')).toBe('successful');
    expect(normalizeErrandStatusForApp('rejected')).toBe('declined');
    expect(normalizeErrandStatusForApp('cancelled_by_customer')).toBe('cancelled');
    expect(normalizeErrandStatusForApp('delivery_failed')).toBe('failed');
  });

  test('normalizes incoming status updates without collapsing explicit unassigned', () => {
    expect(normalizeIncomingStatusRaw('unassigned')).toBe('unassigned');
    expect(normalizeIncomingStatusRaw('pending_pickup')).toBe('acknowledged');
    expect(normalizeIncomingStatusRaw('arrived at restaurant')).toBe('started');
    expect(normalizeIncomingStatusRaw('orderpickup')).toBe('inprogress');
    expect(normalizeIncomingStatusRaw('completed')).toBe('successful');
    expect(normalizeIncomingStatusRaw('delivery_failed')).toBe('failed');
  });

  test('maps delivery status to canonical rider status', () => {
    expect(mapDeliveryToCanonicalTaskStatus('pending_pickup', '')).toBe('acknowledged');
    expect(mapDeliveryToCanonicalTaskStatus('orderpickup', '')).toBe('inprogress');
    expect(mapDeliveryToCanonicalTaskStatus('orderdelivered', '')).toBe('successful');
    expect(mapDeliveryToCanonicalTaskStatus('', 'pending')).toBe('assigned');
  });

  test('treats open/pool orders as assigned for rider-app flow', () => {
    expect(deriveErrandDriverTaskStatus('unassigned', 'pending', null, null)).toBe('assigned');
    expect(deriveErrandDriverTaskStatus('open', 'pending', null, 0)).toBe('assigned');
  });

  test('keeps pickup-ready orders out of pool accept flow', () => {
    expect(deriveErrandDriverTaskStatus('pending_pickup', 'pending', null, 77)).toBe('acknowledged');
  });

  test('keeps completed Mangan orders canonicalized as successful', () => {
    expect(deriveErrandDriverTaskStatus('orderdelivered', 'completed', 'pending_pickup', 77)).toBe('successful');
    expect(deriveErrandDriverTaskStatus('delivered', 'completed', 'arrivedatcustomer', 77)).toBe('successful');
  });
});
