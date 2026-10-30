/**
 * Test environment. Point TEST_DATABASE_URL at a disposable database;
 * the global setup wipes and re-migrates it.
 */
process.env.NODE_ENV = "test";
process.env.APP_ENV = "dev";
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres@localhost:5432/nffl_test";
process.env.BETTER_AUTH_SECRET = "test-secret-test-secret-test-secret-0123";
process.env.APP_BASE_URL = "http://localhost:3000";
delete process.env.RESEND_API_KEY;
