/**
 * Creates database and tables. Run: node -r dotenv/config scripts/init-db.js
 * Ensure MySQL is running and DB_USER has CREATE DATABASE permission.
 */
require('dotenv').config();
const mysql = require('mysql2/promise');

const DB_NAME = process.env.DB_NAME || 'wib_driver';

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
  });
  await conn.query(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await conn.query(`USE \`${DB_NAME}\``);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS settings (
      id INT PRIMARY KEY AUTO_INCREMENT,
      \`key\` VARCHAR(128) NOT NULL UNIQUE,
      value TEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);
  const apiKey = process.env.API_HASH_KEY || 'GodissoGood@33';
  await conn.query(
    'INSERT IGNORE INTO settings (`key`, value) VALUES (?, ?)',
    ['api_hash_key', apiKey]
  );
  await conn.query(
    'INSERT IGNORE INTO settings (`key`, value) VALUES (?, ?), (?, ?), (?, ?)',
    ['website_title', 'When In Baguio', 'mobile_api_url', 'http://localhost:3000/driver/api', 'app_default_language', 'en']
  );

  await conn.query(`
    CREATE TABLE IF NOT EXISTS teams (
      id INT PRIMARY KEY AUTO_INCREMENT,
      name VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS drivers (
      id INT PRIMARY KEY AUTO_INCREMENT,
      username VARCHAR(128) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      token VARCHAR(255) DEFAULT NULL,
      on_duty TINYINT DEFAULT 0,
      device_id VARCHAR(512) DEFAULT NULL,
      device_platform VARCHAR(32) DEFAULT NULL,
      full_name VARCHAR(255) DEFAULT NULL,
      email VARCHAR(255) DEFAULT NULL,
      phone VARCHAR(64) DEFAULT NULL,
      driver_address VARCHAR(512) DEFAULT NULL,
      team_id INT DEFAULT NULL,
      transport_type_id VARCHAR(64) DEFAULT NULL,
      transport_description VARCHAR(255) DEFAULT NULL,
      licence_plate VARCHAR(64) DEFAULT NULL,
      color VARCHAR(64) DEFAULT NULL,
      profile_photo VARCHAR(512) DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE SET NULL
    )
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS driver_locations (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      driver_id INT NOT NULL,
      lat DOUBLE NOT NULL,
      lng DOUBLE NOT NULL,
      accuracy VARCHAR(32) DEFAULT NULL,
      altitude VARCHAR(32) DEFAULT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (driver_id) REFERENCES drivers(id) ON DELETE CASCADE,
      INDEX idx_driver_updated (driver_id, updated_at)
    )
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS driver_queue (
      driver_id INT PRIMARY KEY,
      joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (driver_id) REFERENCES drivers(id) ON DELETE CASCADE
    )
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id INT PRIMARY KEY AUTO_INCREMENT,
      order_id INT DEFAULT NULL,
      task_description TEXT,
      trans_type VARCHAR(64) DEFAULT NULL,
      contact_number VARCHAR(64) DEFAULT NULL,
      email_address VARCHAR(255) DEFAULT NULL,
      customer_name VARCHAR(255) DEFAULT NULL,
      delivery_date DATE DEFAULT NULL,
      delivery_time VARCHAR(32) DEFAULT NULL,
      delivery_address TEXT,
      task_lat VARCHAR(32) DEFAULT NULL,
      task_lng VARCHAR(32) DEFAULT NULL,
      merchant_name VARCHAR(255) DEFAULT NULL,
      merchant_address TEXT,
      status VARCHAR(64) DEFAULT 'unassigned',
      status_raw VARCHAR(64) DEFAULT 'unassigned',
      order_status VARCHAR(64) DEFAULT NULL,
      payment_type VARCHAR(64) DEFAULT NULL,
      order_total_amount VARCHAR(64) DEFAULT NULL,
      driver_id INT DEFAULT NULL,
      task_date DATE DEFAULT NULL,
      date_created TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (driver_id) REFERENCES drivers(id) ON DELETE SET NULL,
      INDEX idx_task_date (task_date),
      INDEX idx_status (status),
      INDEX idx_driver (driver_id)
    )
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INT PRIMARY KEY AUTO_INCREMENT,
      driver_id INT DEFAULT NULL,
      push_title VARCHAR(255) DEFAULT NULL,
      push_message TEXT,
      push_type VARCHAR(64) DEFAULT NULL,
      task_id INT DEFAULT NULL,
      order_id INT DEFAULT NULL,
      is_read TINYINT DEFAULT 0,
      date_created TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (driver_id) REFERENCES drivers(id) ON DELETE CASCADE,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL
    )
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS mt_driver_bulk_push (
      bulk_id INT PRIMARY KEY AUTO_INCREMENT,
      push_title VARCHAR(255) DEFAULT NULL,
      push_message TEXT,
      status VARCHAR(64) DEFAULT 'pending',
      date_created TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      date_process TIMESTAMP NULL DEFAULT NULL,
      ip_address VARCHAR(64) DEFAULT NULL,
      team_id INT DEFAULT NULL,
      user_type VARCHAR(32) DEFAULT NULL,
      user_id INT DEFAULT NULL,
      fcm_response TEXT DEFAULT NULL
    )
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS transport_types (
      id VARCHAR(64) PRIMARY KEY,
      label VARCHAR(128) NOT NULL
    )
  `);
  await conn.query(
    'INSERT IGNORE INTO transport_types (id, label) VALUES (?, ?), (?, ?), (?, ?)',
    ['1', 'Motorcycle', '2', 'Bicycle', '3', 'Car']
  );

  await conn.end();
  console.log('Database and tables created.');
  console.log('  Add a test driver: INSERT INTO drivers (username, password_hash) VALUES ("driver1", "$2a$10$..."); use bcrypt for password.');
  console.log('  Dashboard login uses existing mt_admin_user table (username or email_address + password).');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
