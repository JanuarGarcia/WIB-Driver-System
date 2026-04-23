'use strict';

describe('driver ChangeTaskStatus errand bridge', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('delegates negative synthetic task ids to the errand status handler', async () => {
    const pool = { query: jest.fn() };
    const handleChangeErrandOrderStatus = jest.fn().mockResolvedValue('delegated');
    const driverErrandRoutes = (req, res, next) => (typeof next === 'function' ? next() : undefined);
    driverErrandRoutes.handleChangeErrandOrderStatus = handleChangeErrandOrderStatus;

    jest.doMock('../config/db', () => ({ pool, errandWibPool: {} }));
    jest.doMock('../middleware/auth', () => ({
      validateApiKey: (req, res, next) => next(),
      resolveDriver: (req, res, next) => next(),
      optionalDriver: (req, res, next) => next(),
    }));
    jest.doMock('../lib/response', () => ({
      success: jest.fn(),
      error: jest.fn(),
    }));
    jest.doMock('../services/officeComplianceService', () => ({
      COMPLIANCE_BLOCK_MESSAGE: 'blocked',
      getDriverCompliance: jest.fn().mockResolvedValue(null),
      isComplianceBlocking: jest.fn(() => false),
      compliancePayloadForDriver: jest.fn(() => null),
    }));
    jest.doMock('../lib/passwordVerify', () => ({
      verifyStoredPassword: jest.fn(),
      verifyRiderPasswordResult: jest.fn(),
    }));
    jest.doMock('../lib/riderPasswordCompat', () => ({
      persistPasswordBcryptSidecar: jest.fn(),
      persistPasswordBcryptSidecarMtDriver: jest.fn(),
      persistDualPasswordOnPasswordChangeMtDriver: jest.fn(),
    }));
    jest.doMock('../lib/riderClientForDriverLogin', () => ({
      findRiderClientAcrossDatabases: jest.fn(),
      MSG_NOT_DRIVER: 'not-driver',
    }));
    jest.doMock('../lib/driverLoginRateLimit', () => ({
      checkDriverLoginRateLimit: jest.fn(() => ({ ok: true })),
      clientIp: jest.fn(() => '127.0.0.1'),
    }));
    jest.doMock('../lib/taskProof', () => ({
      fetchTaskProofPhotosWithUrls: jest.fn(),
      buildTaskProofImageUrl: jest.fn(),
      insertDriverTaskPhotoRow: jest.fn(),
      deleteDriverTaskProofSlot: jest.fn(),
      selectDriverTaskProofFileNames: jest.fn(),
      parseProofTypeParam: jest.fn(),
      defaultProofTypeWhenOmitted: jest.fn(),
      inferProofTypeFromFileGroups: jest.fn(),
      sanitizeTaskProofFileName: jest.fn(),
      taskStatusAllowsProofReceipt: jest.fn(),
      taskStatusAllowsProofDelivery: jest.fn(),
    }));
    jest.doMock('../lib/riderOutcomeReason', () => ({
      foodTaskStatusRequiresRiderReason: jest.fn(() => false),
      validateRiderOutcomeReason: jest.fn(() => ({ ok: true, reason: '' })),
    }));
    jest.doMock('../lib/driverOrderHistory', () => ({ fetchDriverMergedOrderHistory: jest.fn() }));
    jest.doMock('../lib/orderDetailAddons', () => ({ enrichOrderDetailsWithSubcategoryAddons: jest.fn() }));
    jest.doMock('../lib/orderDetailCategories', () => ({ attachOrderDetailCategories: jest.fn() }));
    jest.doMock('../lib/dashboardRiderNotify', () => ({ formatActorFromDriver: jest.fn(() => 'Driver') }));
    jest.doMock('../lib/mtOrderHistoryInsert', () => ({ insertMtOrderHistoryRow: jest.fn() }));
    jest.doMock('../lib/mtTaskStatusDashboardNotify', () => ({ notifyDashboardAfterMtTaskHistoryRow: jest.fn() }));
    jest.doMock('../lib/sendCustomerTaskMessage', () => ({
      sendCustomerTaskMessage: jest.fn(),
      sendCustomerTaskNotify: jest.fn(),
    }));
    jest.doMock('../lib/customerOrderPushDispatch', () => ({
      notifyCustomerFoodTaskStatusPushFireAndForget: jest.fn(),
    }));
    jest.doMock('../lib/riderOrderPushDispatch', () => ({
      notifyRiderOrderPushAfterTaskStatusFireAndForget: jest.fn(),
    }));
    jest.doMock('../lib/mtOrderStatusSync', () => ({ updateMtOrderStatusIfDeliveryComplete: jest.fn() }));
    jest.doMock('../lib/errandOrders', () => ({ buildErrandOrderDetailPayloadForDriver: jest.fn() }));
    jest.doMock('../services/driverRealtime', () => ({ subscribeDriverSse: jest.fn() }));
    jest.doMock('../lib/passwordResetStore', () => ({
      issueResetCode: jest.fn(),
      consumeResetCode: jest.fn(),
    }));
    jest.doMock('../routes/driverErrand', () => driverErrandRoutes);

    const router = require('../routes/driver');
    const req = {
      body: { task_id: -174, status_raw: 'declined', reason: 'Customer unreachable' },
      driver: { id: 7 },
    };
    const res = {};

    const out = await router.handleChangeTaskStatus(req, res);

    expect(out).toBe('delegated');
    expect(handleChangeErrandOrderStatus).toHaveBeenCalledWith(req, res);
    expect(pool.query).not.toHaveBeenCalled();
  });
});
