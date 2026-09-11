import {database} from './db';
import {requireRole,type User} from './identity';
import {importWorkbook} from './import-template';
export async function accountWorkbook(branches:{name:string;type:string}[]){return importWorkbook('account',branches);}
export async function accountTemplate(user:User){requireRole(user,['ADMIN','TAX']);const branches=(await database().query('SELECT name,type FROM nota_app.branches WHERE active=true ORDER BY name')).rows;return {fileName:'template-import-akun-gbb.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',branchCount:branches.length,base64:(await accountWorkbook(branches as any)).toString('base64')};}
