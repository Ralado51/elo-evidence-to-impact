import json, urllib.request, sys
O="http://127.0.0.1:8080"
def call(m,p,b=None,tok=None):
    r=urllib.request.Request(O+p,method=m,data=None if b is None else json.dumps(b).encode(),headers={"content-type":"application/json",**({"Authorization":"Bearer "+tok} if tok else {})})
    try:
        x=urllib.request.urlopen(r); return x.status,json.loads(x.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code,json.loads(e.read() or b"null")
s,b=call("POST","/api/v3/auth/therapist",{"username":"terapeuta_demo","password":"senha-sintetica-demo"}); tok=b["token"]
s,b=call("POST","/api/v3/participants",{"alias":"Sonda ARQ03","side":"right"},tok); pid=b["entity_id"]
def goal(kind,value,unit,text="Meta sintética"):
    return call("POST",f"/api/v3/participants/{pid}/goals",{"goal_text":text,"body_segment":"hand","target":{"kind":kind,"value":value,"unit":unit},"status":"active","confirmed_by":None,"confirmed_at":None},tok)
rows=[]
def rec(id,desc,res): 
    s,b=res; code=(b or {}).get("error",{}).get("code","") if s>=400 else ""
    rows.append((id,desc,s,code)); print(f"{id:5} {s} {code:22} {desc}")
G=[("G01","session_count 3 kg (D06)","session_count",3,"kg"),("G02","session_count 3 sessions (caso válido de referência)","session_count",3,"sessions"),
("G03","session_count 2.5 (fracionário)","session_count",2.5,"sessions"),("G04","session_count 0","session_count",0,"sessions"),
("G05","session_count sem valor/unidade (null,null)","session_count",None,None),("G06","session_count valor sem unidade","session_count",3,None),
("G07","repetitions 10 kg","repetitions",10,"kg"),("G08","repetitions 10.5","repetitions",10.5,"reps"),("G09","repetitions 5000 (acima de qualquer limite de dose)","repetitions",5000,"reps"),
("G10","descriptive_text com valor 5 e unidade kg","descriptive_text",5,"kg"),("G11","descriptive_text null/null","descriptive_text",None,None),
("G12","measure_value sem valor e sem unidade","measure_value",None,None),("G13","measure_value 40 unidade inexistente 'banana'","measure_value",40,"banana"),
("G14","measure_value 40 deg (unidade do registro)","measure_value",40,"deg"),("G15","session_count 100000 sessions (limite do schema)","session_count",100000,"sessions"),
("G16","measure_value valor negativo","measure_value",-5,"deg"),("G17","session_count unidade 'deg'","session_count",3,"deg")]
for i,d,k,v,u in G: rec(i,d,goal(k,v,u))
def assess(inst,items,date="2026-03-10"):
    return call("POST",f"/api/v3/participants/{pid}/assessments",{"assessment_date":date,"body_segment":"hand","side":"right","instrument":inst,"items":items,"therapist_note":None},tok)
def item(key="grip",vt="category",val="x",unit=None,src="therapist_observed",a="none",na=False): return {"item_key":key,"value_type":vt,"value":val,"unit":unit,"source":src,"assistance":a,"not_assessed":na}
A=[("A01","instrumento inexistente declarado 'validated_with_therapists'",{"instrument_id":"instrumento_inventado","instrument_version":"1","status":"validated_with_therapists"},[item()]),
("A02","custom_unvalidated declarado 'validated_with_therapists' (FIX-20)",{"instrument_id":"custom_unvalidated","instrument_version":"0","status":"validated_with_therapists"},[item()]),
("A03","custom_unvalidated versão 99 (versão livre)",{"instrument_id":"custom_unvalidated","instrument_version":"99","status":"unvalidated_custom"},[item()]),
("A04","item integer com 2.5",{"instrument_id":"custom_unvalidated","instrument_version":"0","status":"unvalidated_custom"},[item(vt="integer",val=2.5)]),
("A05","item category com valor numérico",{"instrument_id":"custom_unvalidated","instrument_version":"0","status":"unvalidated_custom"},[item(vt="category",val=7)]),
("A06","item boolean com texto",{"instrument_id":"custom_unvalidated","instrument_version":"0","status":"unvalidated_custom"},[item(vt="boolean",val="sim")]),
("A07","not_assessed=true com valor preenchido",{"instrument_id":"custom_unvalidated","instrument_version":"0","status":"unvalidated_custom"},[item(val="x",na=True)]),
("A08","not_assessed=false, valor nulo e assistance not_assessed",{"instrument_id":"custom_unvalidated","instrument_version":"0","status":"unvalidated_custom"},[item(val=None,a="not_assessed")]),
("A09","item number com unidade nula",{"instrument_id":"custom_unvalidated","instrument_version":"0","status":"unvalidated_custom"},[item(vt="number",val=12.5,unit=None)]),
("A10","item number com unidade 'banana'",{"instrument_id":"custom_unvalidated","instrument_version":"0","status":"unvalidated_custom"},[item(vt="number",val=12.5,unit="banana")]),
("A11","item_key duplicado no mesmo instrumento",{"instrument_id":"custom_unvalidated","instrument_version":"0","status":"unvalidated_custom"},[item(),item()]),
("A12","fonte therapist_instrumental sem unidade",{"instrument_id":"custom_unvalidated","instrument_version":"0","status":"unvalidated_custom"},[item(vt="number",val=3,src="therapist_instrumental")])]
for i,d,inst,its in A: rec(i,d,assess(inst,its))
def rx(sets,reps):
    return call("POST","/api/v3/prescriptions",{"participant_id":pid,"exercise_id":"organizar-a-mesa","permitted_movement":"hand_open_close","side":"right","target_sets":sets,"target_repetitions":reps,"sessions_per_week":3,"valid_from":"2026-03-10","valid_to":None,"timezone":"America/Sao_Paulo","min_calibration_span":None,"instructions_ptbr":"Sintético"},tok)
for i,d,s_,r_ in [("R01","dose 3x10 (válida)",3,10),("R02","11 séries",11,10),("R03","101 repetições",1,101),("R04","produto 11x10=110",11,10),("R05","produto 10x11=110",10,11),("R06","produto 10x10=100 (limite)",10,10),("R07","0 séries",0,10),("R08","repetições 0",3,0),("R09","séries fracionárias 2.5",2.5,10)]:
    rec(i,d,rx(s_,r_))
def instr(val,unit,key="wrist_flexion"):
    return call("POST",f"/api/v3/participants/{pid}/instrumental-measurements",{"measured_at":"2026-03-10T12:00:00.000Z","body_segment":"wrist","side":"right","movement_key":key,"value":val,"unit":unit,"instrument_label":"goniômetro sintético","method":"therapist_instrumental_manual","assistance":"none","therapist_note":None},tok)
for i,d,v,u,k in [("M01","flexão de punho 45 deg",45,"deg","wrist_flexion"),("M02","flexão de punho 45 kg",45,"kg","wrist_flexion"),("M03","flexão de punho -9999 deg",-9999,"deg","wrist_flexion"),("M04","flexão de punho 45 unidade '1' (adimensional)",45,"1","wrist_flexion"),("M05","movimento inexistente",1,"deg","movimento_qualquer")]:
    rec(i,d,instr(v,u,k))
json.dump(rows,open("/tmp/evidence/arq03_probe_results.json","w"),ensure_ascii=False,indent=1)
