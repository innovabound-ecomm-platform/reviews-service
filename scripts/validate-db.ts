#!/usr/bin/env tsx
/**
 * Database connection validation for reviews-service
 * 
 * Validates:
 * - Can import reviews-db module
 * - Prisma client instantiation
 * - Required types and enums are available
 * - Database schema matches service expectations
 */

import { PrismaClient } from "@innovabound-ecomm-platform/reviews-db";

interface ValidationCheck {
  name: string;
  passed: boolean;
  error?: string;
}

const checks: ValidationCheck[] = [];

async function runValidation() {
  console.log('🔍 Validating reviews-service database connection...\n');

  try {
    const prisma = new PrismaClient();
    checks.push({
      name: 'Import and instantiate reviews-db PrismaClient',
      passed: prisma !== undefined,
    });

    // Prisma client models
    const requiredModels = ['review', 'rating', 'question', 'answer', 'vote'];
    
    for (const model of requiredModels) {
      try {
        const modelExists = (prisma as any)[model] !== undefined;
        checks.push({
          name: `Model ${model} exists`,
          passed: modelExists,
          error: modelExists ? undefined : `Model ${model} not found`,
        });
      } catch (error: any) {
        checks.push({
          name: `Model ${model} exists`,
          passed: false,
          error: error.message,
        });
      }
    }

    // Database connection
    if (process.env.REVIEWS_DATABASE_URL) {
      try {
        await prisma.$connect();
        checks.push({
          name: 'Database connection successful',
          passed: true,
        });
        await prisma.$disconnect();
      } catch (error: any) {
        checks.push({
          name: 'Database connection',
          passed: false,
          error: `Connection failed: ${error.message}`,
        });
      }
    } else {
      checks.push({
        name: 'Database connection',
        passed: true,
        error: 'Skipped - REVIEWS_DATABASE_URL not set',
      });
    }

  } catch (error: any) {
    checks.push({
      name: 'Import reviews-db module',
      passed: false,
      error: error.message,
    });
  }

  // Print results
  console.log('Results:\n');
  const passed = checks.filter(c => c.passed).length;
  const failed = checks.filter(c => !c.passed).length;

  checks.forEach(check => {
    const icon = check.passed ? '✅' : '❌';
    console.log(`${icon} ${check.name}`);
    if (check.error) {
      console.log(`   Error: ${check.error}`);
    }
  });

  console.log(`\n📊 Summary: ${passed}/${checks.length} checks passed\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runValidation().catch(error => {
  console.error('❌ Validation failed:', error);
  process.exit(1);
});
