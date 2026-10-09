#!/usr/bin/env python3
"""Restore a receipts dump in an isolated container and compare aggregate evidence."""
import subprocess,json,hashlib,time,sys,argparse,uuid
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument("dump",help="Absolute path to a Coolify custom-format receipts dump")
args=parser.parse_args()
P='zmnnqmxbksrj5vzy6ffy1wod'; S='receipts-backup-verify-'+uuid.uuid4().hex[:12]
D=args.dump
def run(args,input=None):
 r=subprocess.run(args,input=input,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 if r.returncode:
  print(json.dumps({'failed_operation':args[0:4],'exit':r.returncode}));raise RuntimeError('Operation failed; details withheld to protect data')
 return r.stdout

def sql(c,u,d,q):return run(['docker','exec',c,'psql','-X','-v','ON_ERROR_STOP=1','-U',u,'-d',d,'-tA','-c',q]).decode().strip()
def counts(c,u,d):
 names=json.loads(sql(c,u,d,"select coalesce(json_agg(tablename order by tablename),'[]') from pg_tables where schemaname='public'"))
 return {n:int(sql(c,u,d,'select count(*) from public."'+n.replace('"','""')+'"')) for n in names}
def schema(c,u,d):
 q="""select coalesce(json_agg(x order by table_name,ordinal_position),'[]') from (select table_name,column_name,row_number() over (partition by table_name order by ordinal_position) as ordinal_position,data_type,is_nullable,column_default from information_schema.columns where table_schema='public') x"""
 return sql(c,u,d,q)
created=False
try:
 run(['docker','run','-d','--name',S,'--network','none','--memory','512m','--cpus','1','--tmpfs','/var/lib/postgresql/data:rw,size=512m','-e','POSTGRES_HOST_AUTH_METHOD=trust',run(['docker','inspect','--format','{{.Image}}',P]).decode().strip()]);created=True
 for _ in range(30):
  r=subprocess.run(['docker','exec',S,'sh','-c','test "$(head -n 1 "$PGDATA/postmaster.pid")" = 1 && pg_isready -U postgres'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  if r.returncode==0:break
  time.sleep(1)
 else:raise RuntimeError('Scratch database readiness timed out')
 run(['docker','cp',D,S+':/tmp/candidate.dmp'])
 run(['docker','exec',S,'createdb','-U','postgres','receipts_restore'])
 run(['docker','exec',S,'pg_restore','--no-owner','--no-privileges','--single-transaction','--exit-on-error','-U','postgres','-d','receipts_restore','/tmp/candidate.dmp'])
 live=counts(P,'receipts','receipts'); restored=counts(S,'postgres','receipts_restore')
 live_schema=json.loads(schema(P,'receipts','receipts')); restored_schema=json.loads(schema(S,'postgres','receipts_restore'));
 schema_equal=live_schema==restored_schema
 structure_query="select coalesce(json_agg(x order by definition),'[]') from (select pg_get_constraintdef(oid) as definition from pg_constraint where connamespace='public'::regnamespace union all select indexdef from pg_indexes where schemaname='public') x"
 constraints_equal=json.loads(sql(P,'receipts','receipts',structure_query))==json.loads(sql(S,'postgres','receipts_restore',structure_query))
 if not schema_equal:
  differences=[{'table':a.get('table_name'),'column':a.get('column_name'),'different_fields':[k for k in a if a[k]!=b.get(k)]} for a,b in zip(live_schema,restored_schema) if a!=b]
  print(json.dumps({'schema_difference_count':len(differences),'schema_differences':differences}))
 checksum=hashlib.sha256(open(D,'rb').read()).hexdigest()
 result={'verified':live==restored and schema_equal and constraints_equal,'dump':D,'bytes':len(open(D,'rb').read()),'sha256':checksum,'public_tables':len(live),'total_rows':sum(live.values()),'row_counts_equal':live==restored,'schema_columns_equal':schema_equal,'constraints_and_indexes_equal':constraints_equal,'nonempty_tables':sum(1 for n in live.values() if n),'network':'none','production_data_mutated':False}
 print(json.dumps(result))
 if not result['verified']:sys.exit(2)
finally:
 if created:
  run(['docker','rm','-f',S]);print(json.dumps({'scratch_container_removed':True}))
