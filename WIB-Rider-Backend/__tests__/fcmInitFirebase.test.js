'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

describe('services/fcm initFirebase', () => {
  const envBackup = { ...process.env };

  afterEach(() => {
    process.env = { ...envBackup };
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('loads service account JSON from FIREBASE_SERVICE_ACCOUNT_PATH when DB setting is empty', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wib-fcm-'));
    const file = path.join(dir, 'service-account.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        project_id: 'demo-project',
        client_email: 'firebase-adminsdk@example.com',
        private_key: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n',
      }),
      'utf8'
    );

    process.env.FIREBASE_SERVICE_ACCOUNT_PATH = file;

    const initializeApp = jest.fn();
    const cert = jest.fn().mockReturnValue('cert-credentials');
    jest.doMock('firebase-admin', () => ({
      apps: [],
      initializeApp,
      credential: { cert },
    }));
    jest.doMock('../config/db', () => ({
      pool: {
        query: jest.fn().mockResolvedValue([[{}]]),
      },
    }));

    const fcm = require('../services/fcm');
    const out = await fcm.initFirebase();

    expect(out).toBeTruthy();
    expect(cert).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: 'demo-project',
        client_email: 'firebase-adminsdk@example.com',
      })
    );
    expect(initializeApp).toHaveBeenCalledWith({ credential: 'cert-credentials' });
  });
});
