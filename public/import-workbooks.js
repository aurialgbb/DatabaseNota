(function(root){
 'use strict';
 const fields={branch:{action:['action','tindakan'],id:['id','idcabang'],name:['name','nama','namacabang'],cv:['cv','namacv'],type:['type','tipe','tipecabang']},account:{role:['role','peran'],branchName:['branchname','namacabang'],branchType:['branchtype','tipecabang'],displayName:['displayname','namatampilan'],username:['username'],password:['password']}};
 const clean=value=>String(value??'').replace(/^\uFEFF/,'').trim();const key=value=>clean(value).toLowerCase().replace(/[\s_*]/g,'');
 function matrixRows(matrix,kind){
  const spec=fields[kind];let header=-1,mapping=[];
  for(let i=0;i<Math.min(matrix.length,20);i++){const columns=matrix[i].map(value=>Object.keys(spec).find(k=>spec[k].includes(key(value)))||'');if(Object.keys(spec).filter(k=>k!=='cv').every(k=>columns.includes(k))){header=i;mapping=columns;break;}}
  if(header<0)throw new Error('Header template '+(kind==='branch'?'cabang':'akun')+' tidak ditemukan. Gunakan template dari aplikasi.');
  if(kind==='branch'&&!mapping.includes('cv'))throw new Error('File memakai template cabang versi lama tanpa kolom Nama CV. Unduh ulang template Excel dari aplikasi, lalu isi data mulai baris 8.');
  if(mapping.filter(Boolean).length!==new Set(mapping.filter(Boolean)).size)throw new Error('Ada nama kolom yang berulang.');
  return matrix.slice(header+1).map((cells,i)=>{const row={_sourceRow:header+i+2};mapping.forEach((name,c)=>{if(name)row[name]=name==='password'?String(cells[c]??''):clean(cells[c]);});if(kind==='branch'){const actions={TAMBAH:'ADD',UBAH:'UPDATE',HAPUS:'DELETE'};row.action=actions[row.action.toUpperCase()]||row.action.toUpperCase();}return row;}).filter(row=>Object.keys(spec).some(k=>row[k]!=null&&row[k]!==''));
 }
 function csvMatrix(text){
  text=String(text||'').replace(/^\uFEFF/,'');const first=text.split(/\r?\n/,1)[0],separator=first.split(';').length>first.split(',').length?';':',';
  const rows=[];let row=[],cell='',quoted=false;
  for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}else if(c===separator&&!quoted){row.push(cell);cell='';}else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&text[i+1]==='\n')i++;row.push(cell);rows.push(row);row=[];cell='';}else cell+=c;}
  if(quoted)throw new Error('Tanda petik CSV belum ditutup.');if(cell||row.length){row.push(cell);rows.push(row);}return rows;
 }
 function workbookRows(workbook,kind,XLSX){const name=kind==='branch'?'Import Cabang':'Import Akun',sheet=workbook.Sheets[name]||workbook.Sheets[workbook.SheetNames[0]];if(!sheet)throw new Error('File tidak memiliki lembar data.');return matrixRows(XLSX.utils.sheet_to_json(sheet,{header:1,defval:'',raw:false,blankrows:true}),kind);}
 const html=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
 const branchField=(record,field)=>field==='cv'?String(record?.data?.cv||''):String(record?.[field]||'');
 const branchFieldLabel={name:'Nama',type:'Tipe',cv:'CV'};
 function importMetric(value,label,tone=''){
  return `<div class="portal-import-metric${tone?' is-'+tone:''}"><strong>${html(value)}</strong><span>${html(label)}</span></div>`;
 }
 function branchChangeHtml(change){
  const action=String(change.action||'NO_CHANGE'),record=change.after||change.before||{},name=record.name||change.id||'Cabang tanpa nama';
  const states={ADD:['Ditambahkan','add'],UPDATE:['Diperbarui','update'],DELETE:['Dihapus','delete'],NO_CHANGE:['Tidak berubah','same']},state=states[action]||states.NO_CHANGE;
  let details='';
  if(action==='UPDATE')details=(change.changedFields||[]).map(field=>`<div class="portal-import-diff"><span>${html(branchFieldLabel[field]||field)}</span><del>${html(branchField(change.before,field)||'Kosong')}</del><small>menjadi</small><ins>${html(branchField(change.after,field)||'Kosong')}</ins></div>`).join('');
  else if(action!=='DELETE')details=`<div class="portal-import-facts"><span>CV: <strong>${html(record.type==='Central Kitchen'?'Tidak berlaku':branchField(record,'cv')||'Belum diisi')}</strong></span><span>Tipe: <strong>${html(record.type||'Belum diisi')}</strong></span></div>`;
  else details=`<p class="portal-import-row-note">${html(record.type||'Tipe belum tersedia')}${record.type==='Mandiri'&&branchField(record,'cv')?' · CV '+html(branchField(record,'cv')):''}</p>`;
  return `<article class="portal-import-row"><div class="portal-import-row-head"><div><strong>${html(name)}</strong><span>Baris ${html(change.row)} · ID ${html(change.id||'dibuat otomatis')}</span></div><b class="portal-import-status is-${state[1]}">${state[0]}</b></div>${details}</article>`;
 }
 function branchPreviewHtml(preview){
  const summary=preview?.summary||{},changes=preview?.changes||[],changed=(summary.add||0)+(summary.update||0)+(summary.remove||0);
  return `<div class="portal-import-preview"><div class="portal-import-summary">${importMetric(changed,'Akan diterapkan','primary')}${importMetric(summary.add||0,'Ditambah','add')}${importMetric(summary.update||0,'Diperbarui','update')}${importMetric(summary.remove||0,'Dihapus','delete')}${summary.unchanged?importMetric(summary.unchanged,'Tidak berubah','same'):''}</div><p class="portal-import-guidance">Periksa nama, CV, dan tipe cabang. CK tidak memakai CV. Data belum diubah.</p><div class="portal-import-list">${changes.map(branchChangeHtml).join('')||'<div class="portal-import-empty">Tidak ada perubahan yang perlu diterapkan.</div>'}</div></div>`;
 }
 function importErrorsHtml(errors,subject){
  const items=(errors||[]).map(item=>typeof item==='string'?item:`Baris ${item.row}: ${item.error}`);
  return `<div class="portal-import-preview"><p class="portal-import-guidance is-error">Tidak ada ${html(subject)} yang diproses. Perbaiki bagian berikut, lalu unggah kembali.</p><div class="portal-import-list is-error-list">${items.map(item=>`<div class="portal-import-error"><strong>${html(String(item).match(/^Baris \d+/)?.[0]||'Periksa data')}</strong><span>${html(String(item).replace(/^Baris \d+:?\s*/,''))}</span></div>`).join('')}</div></div>`;
 }
 function accountPreviewHtml(analysis,fileName){
  const rows=analysis?.filledRows||[],counts=analysis?.roleCounts||{},warnings=analysis?.branchWarnings||[];
  const list=rows.map((row,index)=>{const role=String(row.role||'').toUpperCase(),branch=String(row.branchName||row.namaCabang||row.branchId||'');return `<article class="portal-import-row"><div class="portal-import-row-head"><div><strong>${html(row.username||'Tanpa username')}</strong><span>Baris ${html(row._sourceRow||index+2)}${role==='TOKO'&&branch?' · '+html(branch):''}</span></div><b class="portal-import-status is-${role==='TOKO'?'add':'update'}">${html(role)}</b></div>${row.displayName?`<p class="portal-import-row-note">Nama tampilan: ${html(row.displayName)}</p>`:''}</article>`;}).join('');
  const warningHtml=warnings.length?`<section class="portal-import-warning"><strong>Perlu diperiksa sebelum melanjutkan</strong>${warnings.map(item=>`<p>${html(item)}</p>`).join('')}</section>`:'';
  return `<div class="portal-import-preview"><p class="portal-import-file">${html(fileName||'File akun')}</p><div class="portal-import-summary">${importMetric(rows.length,'Total akun','primary')}${importMetric(counts.TOKO||0,'Toko','add')}${importMetric(counts.TAX||0,'Tax','update')}${importMetric(counts.ADMIN||0,'Admin','same')}</div><p class="portal-import-guidance">Periksa username, peran, dan cabang. Password tidak ditampilkan pada preview. Data belum diubah.</p><div class="portal-import-list">${list||'<div class="portal-import-empty">Tidak ada akun yang dapat diimport.</div>'}</div>${warningHtml}</div>`;
 }
 root.NotaImport={matrixRows,csvRows:(text,kind)=>matrixRows(csvMatrix(text),kind),workbookRows,branchPreviewHtml,importErrorsHtml,accountPreviewHtml};
})(globalThis);
