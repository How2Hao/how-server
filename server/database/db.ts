// 数据库连接：mysql2 连接池 + drizzle 实例（全局单例，dev 热重载安全）
import { drizzle } from 'drizzle-orm/mysql2'
import mysql from 'mysql2/promise'
import { config } from '../utils/config'
import * as schema from './schema'

function createPool(): mysql.Pool {
  const cfg = config.db
  return mysql.createPool({
    host: cfg.host,
    port: cfg.port,
    user: cfg.username,
    password: cfg.password,
    database: cfg.database,
    connectionLimit: 10,
    // bigint 返回 number（与 drizzle bigint mode:'number' 配合）
    supportBigNumbers: true,
    bigNumberStrings: false,
    decimalNumbers: false,
  })
}

const g = globalThis as typeof globalThis & {
  __howPool?: mysql.Pool
  __howDb?: ReturnType<typeof createDb>
}

function createDb() {
  return drizzle(g.__howPool!, { schema, mode: 'default' })
}

export const pool: mysql.Pool = (g.__howPool ??= createPool())
export const db = (g.__howDb ??= createDb())
export { schema }
