import { betterAuth } from 'better-auth';
import { Kysely, PostgresDialect } from 'kysely';
import { database } from './db';
import { invariant } from './errors';
let instance: ReturnType<typeof createAccountAuth> | undefined;
function createAccountAuth() {
 invariant((process.env.BETTER_AUTH_SECRET || '').length >= 32, 'AUTH_NOT_CONFIGURED', 'Login belum dikonfigurasi.', 503);
 return betterAuth({
  appName: 'Database Nota', secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.APP_ORIGIN, basePath: '/api/account-auth',
  trustedOrigins: [process.env.APP_ORIGIN || 'http://localhost:3000'],
  database: {db:new Kysely<any>({dialect:new PostgresDialect({pool:database()})}).withSchema('nota_app'),type:'postgres'},
  emailAndPassword: {enabled:true,disableSignUp:true,minPasswordLength:12,maxPasswordLength:128},
  user: {modelName:'auth_user'}, account: {modelName:'auth_account'},
  verification: {modelName:'auth_verification'},
  session: {modelName:'auth_session',expiresIn:4*60*60,updateAge:60*60,cookieCache:{enabled:false}},
  advanced: {useSecureCookies:process.env.NODE_ENV==='production',cookiePrefix:'nota',defaultCookieAttributes:{httpOnly:true,sameSite:'strict',path:'/'}}
 });
}

export function accountAuth(){ return instance ||= createAccountAuth(); }
