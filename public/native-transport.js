(function () {
  'use strict';
  function canonical(value) {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k)+':'+canonical(value[k])).join(',') + '}';
    return JSON.stringify(value);
  }
  async function request(path, method, body, key) {
    const response = await fetch(path, {method,credentials:'same-origin',headers:method==='GET'?{}:{'content-type':'application/json',...(key?{'Idempotency-Key':key}:{})},body:method==='GET'?undefined:JSON.stringify(body)});
    const envelope = await response.json();
    if (!response.ok || !envelope.ok) throw Object.assign(new Error(envelope.error?.message || 'Server belum merespons.'),{code:envelope.error?.code});
    return envelope.result;
  }
  async function upload(image, uploadId, branchId) {
    const content = image.base64 || image.data || '';
    const blob = await (await fetch('data:'+(image.mimeType||'image/jpeg')+';base64,'+content)).blob();
    const slot = await request('/api/uploads','POST',{size:blob.size,mimeType:blob.type,uploadId,branchId});
    const sent=await fetch(slot.uploadUrl,{method:'PUT',headers:{'content-type':blob.type},body:blob});
    if(!sent.ok) throw new Error('Foto belum berhasil diunggah.');
    if(image.thumbnailBase64){
      const thumbnail=await (await fetch('data:image/jpeg;base64,'+image.thumbnailBase64)).blob();
      const thumbResponse=await fetch(slot.thumbnailUploadUrl,{method:'PUT',headers:{'content-type':'image/jpeg'},body:thumbnail});
      if(!thumbResponse.ok) throw new Error('Thumbnail belum berhasil diunggah.');
    }
    await request('/api/uploads/'+slot.photoId+'/complete','POST',{});
    return slot.photoId;
  }
  async function waitJob(id) {
    const started=Date.now();
    for(;;){
      const job=await request('/api/jobs/'+id,'GET');
      if(job.status==='SUCCEEDED')return job.result;
      if(['FAILED','NEEDS_REVIEW'].includes(job.status)&&job.kind==='SHEET_SYNC')return job.result?.status==='RECOVERY_REQUIRED'?job.result:{success:false,status:'RECOVERY_REQUIRED',operationId:'TARIK-'+id,message:'Pekerjaan perlu diperiksa sebelum dilanjutkan.'};
      if(['FAILED','NEEDS_REVIEW','CANCELLED'].includes(job.status))throw new Error(job.result?.message||job.message||'Pekerjaan perlu diperiksa.');
      window.dispatchEvent(new CustomEvent('nota-job-progress',{detail:job}));
      const delay=document.hidden?15000:Date.now()-started<10000?1000:Date.now()-started<60000?2000:5000;
      await new Promise(resolve=>setTimeout(resolve,delay));
    }
  }
  async function invoke(name,args){
    if(name==='getPortalSetupStatus')return request('/api/setup','GET');
    if(name==='portalLogin'){
      const value=await request('/api/auth/login','POST',args[0]);
      return {...value,sessionToken:'native-cookie'};
    }
    if(name==='portalGetSession')return request('/api/auth/session','GET');
    if(name==='portalLogout')return request('/api/auth/logout','POST',{});
    const legacy=name==='portalLegacyApi';
    if(!legacy&&name!=='portalApi')throw new Error('Tindakan tidak tersedia pada aplikasi baru.');
    const action=args[1], original=legacy?args[2]:args[2]||{};
    let payload=structuredClone(original);
    if(!legacy && action==='CHANGE_PASSWORD') {
      const confirm=await Swal.fire({title:'Konfirmasi password saat ini',input:'password',inputAttributes:{autocomplete:'current-password'},showCancelButton:true,confirmButtonText:'Lanjutkan',cancelButtonText:'Batal'});
      if(!confirm.isConfirmed || !confirm.value)throw new Error('Perubahan password dibatalkan.');
      payload.currentPassword=confirm.value;
    }
    const identity=canonical({legacy,action,payload});
    const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(identity)))).map(v=>v.toString(16).padStart(2,'0')).join('');
    const storageKey='nota-native-pending-'+digest;
    let key=sessionStorage.getItem(storageKey);
    if(!key){key=crypto.randomUUID();sessionStorage.setItem(storageKey,key);}
    if(!legacy&&action==='PROCESS_STORE_OCR_PHOTO'&&payload.image?.base64){
      const uploadKey='nota-upload-photo-'+payload.uploadId+'-'+payload.clientPhotoId;
      let photoId=sessionStorage.getItem(uploadKey);
      if(!photoId){photoId=await upload(payload.image,payload.uploadId);sessionStorage.setItem(uploadKey,photoId);}
      payload={...payload,photoId,fileName:payload.image.fileName};delete payload.image;
    }
    if(legacy&&['saveListrikTransaction','updateListrikTransaction'].includes(action)){
      const data=payload[action==='updateListrikTransaction'?1:0];
      if(data?.base64){
        const raw=String(data.base64),mime=raw.match(/^data:([^;]+);/)?.[1]||'image/jpeg';
        data.photoId=sessionStorage.getItem(storageKey+'-photo');
        if(!data.photoId){data.photoId=await upload({base64:raw.replace(/^data:[^,]+,/,''),mimeType:mime});sessionStorage.setItem(storageKey+'-photo',data.photoId);}
        delete data.base64;
      }
    }
    if(legacy&&['submitTarikDataBatch','resetTarikDataBatch'].includes(action)&&payload[0])payload[0].cabang=document.getElementById('tarikCabang')?.value||payload[0].cabang;
    if(legacy&&action==='submitTarikDataBatch'){
      for(const group of ['newItems','photoItemsExisting'])for(let index=0;index<(payload[0]?.[group]||[]).length;index++){
        const item=payload[0][group][index];if(!item.base64)continue;
        const photoKey=storageKey+'-'+group+'-'+index,raw=String(item.base64);item.photoId=sessionStorage.getItem(photoKey);
        if(!item.photoId){item.photoId=await upload({base64:raw.replace(/^data:[^,]+,/,''),mimeType:raw.match(/^data:([^;]+);/)?.[1]||'image/jpeg'});sessionStorage.setItem(photoKey,item.photoId);}
        delete item.base64;
      }
    }
    if(legacy&&action==='saveTransactions'&&payload[0]){
      const date=document.getElementById('dateInput')?._flatpickr?.selectedDates?.[0];
      if(date)payload[0].tanggal=[date.getFullYear(),String(date.getMonth()+1).padStart(2,'0'),String(date.getDate()).padStart(2,'0')].join('-');
    }
    if(legacy&&action==='saveTransactions'&&payload[0]?.base64?.length){
      payload[0].photoIds=JSON.parse(sessionStorage.getItem(storageKey+'-photos')||'[]');
      for(let i=payload[0].photoIds.length;i<payload[0].base64.length;i++){
        const text=String(payload[0].base64[i]);payload[0].photoIds.push(await upload({base64:text.replace(/^data:[^,]+,/,''),mimeType:text.match(/^data:([^;]+);/)?.[1]||'image/jpeg'}));
        sessionStorage.setItem(storageKey+'-photos',JSON.stringify(payload[0].photoIds));
      }
      delete payload[0].base64;
    }
    if(legacy&&action==='processOCRWithGemini'){
      const image=Array.isArray(payload[0])?payload[0][0]:payload[0];
      let photoId=sessionStorage.getItem(storageKey+'-photo');
      if(!photoId){photoId=await upload({base64:String(image).replace(/^data:[^,]+,/,''),mimeType:String(image).match(/^data:([^;]+);/)?.[1]||'image/jpeg'});sessionStorage.setItem(storageKey+'-photo',photoId);}
      payload=[{photoId}];
    }
    const result=await request('/api/rpc','POST',{operation:legacy?'LEGACY_API':'PORTAL_API',action,payload},key);
    const final=result?.operationId&&result.awaitResult?await waitJob(result.operationId):result;
    if(final?.success!==false&&!final?.pending&&!final?.queued){sessionStorage.removeItem(storageKey);sessionStorage.removeItem(storageKey+'-photo');sessionStorage.removeItem(storageKey+'-photos');}
    if(!legacy&&['MOVE_RECEIPT_DATE','ELIMINATE_RECEIPT'].includes(action)&&final?.success===false)throw new Error(final.message+' ('+final.operationId+')');
    return final;
  }
  function runner(success, failure){
    return new Proxy({}, {get(_, key){
      if(key==='withSuccessHandler')return fn=>runner(fn,failure);
      if(key==='withFailureHandler')return fn=>runner(success,fn);
      if(key==='then')return undefined;
      return (...args)=>{invoke(key,args).then(success||(()=>{}),failure||console.error);};
    }});
  }
  window.PortalNative={script:{get run(){return runner();}},request,waitJob};
})();


