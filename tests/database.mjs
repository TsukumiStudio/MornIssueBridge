import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
export function database() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../migrations/0001_reports.sql', import.meta.url), 'utf8'));
  return {
    prepare(sql) {
      const statement = db.prepare(sql);
      return { bind(...args) {
        return {
          async run() { return statement.run(...args); },
          async all() { return { results: statement.all(...args) }; },
        };
      } };
    },
  };
}
