DELETE FROM nota_app.transactions
WHERE data ? 'sourceReceiptId';

INSERT INTO nota_app.transactions(id,kind,branch_id,business_date,amount,data)
SELECT
  'APR-' || i.id,
  CASE WHEN upper(trim(i.category)) = 'LISTRIK' THEN 'LISTRIK' ELSE 'UMUM' END,
  r.branch_id,
  r.receipt_date,
  i.amount,
  jsonb_build_object(
    'id','APR-' || i.id,
    'timestamp',floor(extract(epoch FROM coalesce(to_timestamp(nullif(r.data->>'approvedAt','')::double precision / 1000),r.updated_at)) * 1000),
    'tanggal',floor(extract(epoch FROM (r.receipt_date::timestamp AT TIME ZONE 'Asia/Jakarta')) * 1000),
    'cabang',upper(b.name),
    'cv',b.type,
    'nominal',i.amount,
    'fotoUrl',CASE WHEN coalesce(r.data->>'photoId','') <> '' THEN '/api/photos/' || (r.data->>'photoId') ELSE '-' END,
    'kategori',CASE WHEN upper(trim(i.category)) = 'LISTRIK' THEN 'Listrik' ELSE 'Umum' END,
    'keterangan',i.description,
    'noUrut','',
    'jenis',upper(i.category),
    'jumlah',trim(to_char(i.quantity,'FM999999990.######') || ' ' || coalesce(i.unit,'')),
    'sourceReceiptId',r.id,
    'sourceItemId',i.id,
    'readOnly',true
  )
FROM nota_app.receipts r
JOIN nota_app.receipt_items i ON i.receipt_id=r.id
JOIN nota_app.branches b ON b.id=r.branch_id
WHERE r.status='APPROVED'
ON CONFLICT(id) DO UPDATE SET
  kind=excluded.kind,
  branch_id=excluded.branch_id,
  business_date=excluded.business_date,
  amount=excluded.amount,
  data=excluded.data,
  version=nota_app.transactions.version+1,
  updated_at=now();

CREATE INDEX IF NOT EXISTS transactions_source_receipt
ON nota_app.transactions ((data->>'sourceReceiptId'))
WHERE data ? 'sourceReceiptId';
