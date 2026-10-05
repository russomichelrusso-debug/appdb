import math, random, struct, wave
SR=44100; DUR=23.5; N=int(SR*DUR)
L=[0.0]*N; R=[0.0]*N
random.seed(7)
def mtof(m): return 440*2**((m-69)/12)
def add(t0,sig,gain=1.0,pan=0.0):
    i0=int(t0*SR); gl=gain*(1-max(0,pan)); gr=gain*(1+min(0,pan))
    for k,v in enumerate(sig):
        i=i0+k
        if i>=N: break
        if i<0: continue
        L[i]+=v*gl; R[i]+=v*gr
def env(n,a,d,s,r):
    e=[]
    for k in range(n):
        t=k/SR; T=n/SR
        if t<a: v=t/a
        elif t<a+d: v=1-(1-s)*(t-a)/d
        elif t<T-r: v=s
        else: v=s*max(0,(T-t)/r)
        e.append(v)
    return e
def tone(f,dur,a=.005,d=.1,s=.5,r=.1,harm=(1,),det=0.0):
    n=int((dur+r)*SR); e=env(n,a,d,s,r)
    out=[0.0]*n
    for hi,h in enumerate(harm):
        w=2*math.pi*f*(hi+1)/SR*(1+det)
        for k in range(n): out[k]+=h*math.sin(w*k)
    return [out[k]*e[k] for k in range(n)]
def lp(sig,fc):
    a=1-math.exp(-2*math.pi*fc/SR); y=0; o=[]
    for v in sig: y+=a*(v-y); o.append(y)
    return o
def noise(n): return [random.uniform(-1,1) for _ in range(n)]
def kick(g=1):
    n=int(.28*SR); o=[]; ph=0
    for k in range(n):
        t=k/SR; f=45+90*math.exp(-t*28); ph+=2*math.pi*f/SR
        o.append(math.sin(ph)*math.exp(-t*11))
    return [v*g for v in o]
def hat(g=1):
    n=int(.05*SR); x=noise(n); x=[x[k]-(x[k-1] if k else 0) for k in range(n)]
    return [x[k]*math.exp(-k/SR*70)*g for k in range(n)]
def whoosh(dur=.5,fc0=400,fc1=2400,g=1):
    n=int(dur*SR); x=noise(n); o=[]; y=0
    for k in range(n):
        p=k/n; fc=fc0+(fc1-fc0)*p; a=1-math.exp(-2*math.pi*fc/SR); y+=a*(x[k]-y)
        o.append(y*math.sin(math.pi*p)**1.5*g)
    return o
def click(g=1):
    n=int(.04*SR); x=lp(noise(n),3500)
    t=tone(1800,.03,a=.001,d=.02,s=0,r=.01)
    return [(x[k]*math.exp(-k/SR*120)*.8+(t[k] if k<len(t) else 0)*.25)*g for k in range(n)]

# --- music
bpm=120; beat=60/bpm
chords=[[57,60,64],[53,57,60],[48,52,55],[55,59,62]]   # Am F C G (triads)
roots=[45,41,36,43]
def bar_start(b): return b*4*beat
MUS_START=0.0
# pad: continuous, fades in 1.5-3.0, thins during hook
for b in range(12):
    t0=bar_start(b)
    if t0>=20.0: break
    ch=chords[b%4]
    amp = 0.0
    for m in ch:
        sig=tone(mtof(m),4*beat,a=.6,d=.3,s=.8,r=.6,harm=(1,.35,.12),det=.002)
        sig2=tone(mtof(m)*1.004,4*beat,a=.6,d=.3,s=.8,r=.6,harm=(1,.3),det=0)
        sig=lp([sig[k]+(sig2[k] if k<len(sig2) else 0) for k in range(len(sig))],1800)
        g=0.05 if t0<2.0 else 0.08
        add(t0,sig,g,pan=0.15 if m%2 else -0.15)
# bass from bar 1 (t=2.0): root on beats 1 and "and of 2"
for b in range(1,10):
    t0=bar_start(b)
    r=roots[b%4]
    for off,dur in ((0,.9),(1.5,.45),(2,.9),(3.5,.45)):
        if t0+off*beat>=19.9: continue
        sig=lp(tone(mtof(r),dur*beat*1.6,a=.01,d=.2,s=.5,r=.12,harm=(1,.5,.2)),500)
        add(t0+off*beat,sig,.2)
# drums from 3.0 to 19.5
t=3.0
while t<19.5:
    bi=round((t-3.0)/beat)
    if bi%2==0 or True:
        pass
    if bi%4 in (0,2): add(t,kick(),.28)
    if bi%4 in (1,3):
        pass
    add(t+beat/2,hat(),.05 if bi%2 else .035,pan=.2)
    add(t,hat(),.02,pan=-.2)
    t+=beat
# snare-ish soft clap on 2 and 4
t=3.0+beat
while t<19.5:
    n=int(.14*SR); x=lp(noise(n),4200); add(t,[x[k]*math.exp(-k/SR*26) for k in range(n)],.08)
    t+=2*beat
# arp (8ths) from 3.0, Am pent-ish pluck
patterns=[[0,1,2,1,2,1,0,2],[0,2,1,2,0,2,1,2]]
for b in range(6,40):
    t0=bar_start(b-6)+3.0
    if t0>=19.4: break
    ch=chords[(b-6)%4]
    for s in range(8):
        tt=t0+s*beat/2
        if tt>=19.4: break
        m=ch[patterns[(b)%2][s]%3]+12
        sig=lp(tone(mtof(m),.25,a=.003,d=.15,s=.0,r=.1,harm=(1,.5,.25,.1)),3200)
        add(tt,sig,.055,pan=-.3 if s%2 else .3)
# lead-in riser during hook end (2.0-3.0)
add(2.0,whoosh(1.0,300,3500,.12),1)
# final chord (Am add9 -> resolve to C) 20.0 -> end
for m in (45,57,60,64,67):
    sig=lp(tone(mtof(m),3.2,a=.02,d=.5,s=.7,r=1.2,harm=(1,.4,.15),det=.002),2400)
    add(20.0,sig,.1 if m>50 else .16,pan=.1)
add(20.0,kick(),.35)
for m in (72,76,79,84):
    add(20.05+(m-72)*.001,lp(tone(mtof(m),1.5,a=.002,d=.5,s=0,r=.5,harm=(1,.3)),5000),.06,pan=.2)

# --- sfx (soft, in key: A minor)
def thock(t,m=57): add(t,lp(tone(mtof(m),.18,a=.001,d=.1,s=0,r=.06,harm=(1,.6,.3)),1500),.28); add(t,lp(noise(int(.05*SR)),2500),.0)
for t_,m in ((.5,57),(1.1,60),(1.7,64)):
    thock(t_,m-12); add(t_,whoosh(.18,1500,5000,.06),1)
# "Um app só" hit
add(2.02,kick(),.3)
for m in (69,72):
    add(2.05,lp(tone(mtof(m),.5,a=.004,d=.3,s=0,r=.3,harm=(1,.4)),3500),.07)
# reveal hit at 3.0
add(3.0,whoosh(.6,200,1500,.08),1)
for m in (64,69,76):
    add(3.05,lp(tone(mtof(m),1.2,a=.004,d=.5,s=0,r=.5,harm=(1,.35)),3500),.07,pan=.1)
# transitions
for t_ in (5.25,9.45,13.95,17.45,19.5):
    add(t_,whoosh(.55,250,2200,.09),1)
# typing ticks
for k in range(11):
    add(6.0+k*.081,click(),.05,pan=.1)
for i in range(4): add(6.8+i*.15,lp(tone(mtof(76+ i),.12,a=.002,d=.08,s=0,r=.05),4000),.025,pan=.2)
# taps
def tap(t): add(t,click(),.14); add(t,lp(tone(mtof(81),.12,a=.002,d=.08,s=0,r=.05),3000),.04)
for t_ in (8.85,13.6,15.2,18.55): tap(t_)
# confirm blip after add
add(8.92,lp(tone(mtof(88),.25,a=.002,d=.12,s=0,r=.12,harm=(1,.3)),5000),.05,pan=.2)
# scan beeps E5-ish
for i,t_ in enumerate((10.8,11.6,12.4)):
    add(t_,tone(mtof(88),.12,a=.002,d=.05,s=.4,r=.05,harm=(1,.15)),.05,pan=-.1)
    add(t_,tone(mtof(95 if i<2 else 100),.14,a=.002,d=.05,s=.4,r=.06,harm=(1,.1)),.03,pan=-.1)
# sheets
for t_ in (12.9,15.35,17.7): add(t_,whoosh(.45,300,1800,.08),1)
# list pops
for t_ in (15.7,15.84,15.98): add(t_,lp(tone(mtof(76),.1,a=.002,d=.06,s=0,r=.04),3000),.025)
# send chime 18.75 (Am pentatonic up)
for k,m in enumerate((81,84,88,93)):
    add(18.75+k*.07,lp(tone(mtof(m),.7,a=.003,d=.3,s=0,r=.35,harm=(1,.3,.1)),5500),.07,pan=-.2+k*.15)
# outro lines
for k,t_ in enumerate((20.15,20.35,20.55)):
    add(t_,lp(tone(mtof(72+k*2),.3,a=.003,d=.15,s=0,r=.12),3500),.03,pan=.15)

# master: fade in/out, soft clip, normalize
def fade(x):
    for i in range(N):
        t=i/SR; g=min(1,t/.05, max(0,(DUR-t)/1.2)); x[i]*=g
fade(L); fade(R)
pk=max(max(abs(v) for v in L),max(abs(v) for v in R))
g=0.89/pk
def soft(v): return math.tanh(v*g*1.1)/math.tanh(1.1)
w=wave.open('audio.wav','wb'); w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
buf=bytearray()
for i in range(N):
    buf+=struct.pack('<hh',int(soft(L[i])*32000),int(soft(R[i])*32000))
w.writeframes(bytes(buf)); w.close()
print('peak',pk)
