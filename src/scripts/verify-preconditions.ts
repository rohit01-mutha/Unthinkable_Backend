import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import app from '../index';
import fs from 'fs';
import path from 'path';

async function verifyPreconditions() {
  console.log('=== STARTING PRECONDITION VERIFICATIONS ===\n');

  // Precondition 1: Verify CORS boundary crossing headers
  console.log('1. Verifying CORS headers...');
  const res = await request(app)
    .options('/')
    .set('Origin', 'http://localhost:5173')
    .set('Access-Control-Request-Method', 'GET');

  console.log(`- Origin header allowed: ${res.headers['access-control-allow-origin']}`);
  console.log(`- Credentials allowed: ${res.headers['access-control-allow-credentials']}`);

  const matchesOrigin = res.headers['access-control-allow-origin'] === 'http://localhost:5173';
  const matchesCreds = res.headers['access-control-allow-credentials'] === 'true';

  if (matchesOrigin && matchesCreds) {
    console.log('✔ CORS boundary checks PASSED!');
  } else {
    console.log('❌ CORS boundary checks FAILED!');
  }

  // Precondition 2: Verify append-only constraints on AgentVerificationLog and OrderStatusHistory
  console.log('\n2. Verifying append-only database operations in controllers/services...');

  const controllerDir = path.join(__dirname, '../controllers');
  const serviceDir = path.join(__dirname, '../services');
  const filesToCheck: string[] = [];

  // Helper to read directory recursively
  function getFiles(dir: string) {
    if (!fs.existsSync(dir)) return;
    const list = fs.readdirSync(dir);
    list.forEach((file) => {
      const fullPath = path.join(dir, file);
      const stat = fs.statSync(fullPath);
      if (stat && stat.isDirectory()) {
        getFiles(fullPath);
      } else if (file.endsWith('.ts') || file.endsWith('.js')) {
        filesToCheck.push(fullPath);
      }
    });
  }

  getFiles(controllerDir);
  getFiles(serviceDir);

  let clean = true;
  const violationPatterns = [
    /\.agentVerificationLog\s*\.\s*(update|delete|updateMany|deleteMany)\b/i,
    /\.orderStatusHistory\s*\.\s*(update|delete|updateMany|deleteMany)\b/i,
  ];

  filesToCheck.forEach((filePath) => {
    const content = fs.readFileSync(filePath, 'utf-8');
    const relativePath = path.relative(path.join(__dirname, '../../'), filePath);

    violationPatterns.forEach((pattern) => {
      if (pattern.test(content)) {
        console.log(`❌ VIOLATION FOUND in ${relativePath}: matches append-only query pattern ${pattern.toString()}`);
        clean = false;
      }
    });
  });

  if (clean) {
    console.log('✔ Append-only immutability checks PASSED! No update or delete logic exists for audit logs.');
  }

  console.log('\n=== PRECONDITION VERIFICATIONS COMPLETED ===');
}

verifyPreconditions().catch((err) => {
  console.error(err);
});
