import { describe, expect, it } from 'vitest';
import {
  HostedWorkspaceConnectorGateway,
  type HostedConnectorBinding,
  type HostedConnectorTicketBinding,
  type HostedConnectorTicketKind,
  type HostedConnectorTransport,
  type HostedWorkspaceConnectorStore,
} from './hosted-workspace-connector';
import {
  authenticateHostedConnectorSocket,
  authenticateHostedConnectorTransport,
} from './routes/hosted-workspace-connector';

class MemoryStore implements HostedWorkspaceConnectorStore {
  binding: HostedConnectorBinding | null = null;
  credentialHash: string | null = null;
  tickets = new Map<string, HostedConnectorTicketBinding>();
  createEnrollment(input: Omit<HostedConnectorBinding,'generation'|'state'> & {ticketHash:string;expiresAt:Date}) { this.binding={...input,generation:(this.binding?.generation??0)+1,state:'pending'};this.tickets.set(input.ticketHash,{...this.binding,kind:'enrollment',audience:'connector-register',expiresAt:input.expiresAt});return Promise.resolve(this.binding); }
  register(hash:string,credentialHash:string,now:Date){const ticket=this.take(hash,'enrollment',now);if(!ticket||!this.binding||ticket.generation!==this.binding.generation)return Promise.resolve(null);this.credentialHash=credentialHash;this.binding={...this.binding,state:'active'};return Promise.resolve(this.binding);}
  authenticate(hash:string){return Promise.resolve(this.binding?.state==='active'&&hash===this.credentialHash?this.binding:null);}
  heartbeat(hash:string,transport:HostedConnectorTransport){if(this.binding?.state!=='active'||hash!==this.credentialHash||transport!==this.binding.transport)return Promise.resolve(null);return Promise.resolve(this.binding);}
  issueSessionTicket(input:HostedConnectorTicketBinding&{ticketHash:string;issuedAt:Date}){if(this.binding?.state!=='active')return Promise.resolve(null);const ticket={...input,...this.binding,expiresAt:input.expiresAt,issuedAt:input.issuedAt,ticketHash:input.ticketHash,kind:'session' as const};this.tickets.set(input.ticketHash,ticket);return Promise.resolve(ticket);}
  consumeTicket(hash:string,kind:HostedConnectorTicketKind,now:Date){return Promise.resolve(this.take(hash,kind,now));}
  rotate(input:Omit<HostedConnectorBinding,'generation'|'state'>&{ticketHash:string;expiresAt:Date;now:Date}){if(this.binding?.state!=='active')return Promise.resolve(null);this.binding={...input,generation:this.binding.generation+1,state:'pending'};this.credentialHash=null;this.tickets.set(input.ticketHash,{...this.binding,kind:'enrollment',audience:'connector-register',expiresAt:input.expiresAt});return Promise.resolve(this.binding);}
  revoke(){if(!this.binding)return Promise.resolve(null);this.binding={...this.binding,state:'revoked'};this.credentialHash=null;return Promise.resolve(this.binding);}
  private take(hash:string,kind:HostedConnectorTicketKind,now:Date){const value=this.tickets.get(hash);if(!value||value.kind!==kind||value.expiresAt<=now||value.generation!==this.binding?.generation||this.binding.state!==(kind==='enrollment'?'pending':'active'))return null;this.tickets.delete(hash);return value;}
}

const binding={controlPlaneWorkspaceId:'control',organizationId:'org-1',customerWorkspaceId:'workspace-1',hostId:'host-1',routeLabel:'alpha',transport:'websocket' as const};
function entropy(){let byte=0;return(size:number)=>new Uint8Array(size).fill(++byte);}

async function activeGateway(clock: { now: Date }) {
  const gateway = new HostedWorkspaceConnectorGateway(new MemoryStore(), () => clock.now, entropy());
  await gateway.register((await gateway.enroll(binding)).ticket);
  return gateway;
}

function browserUpgrade(ticket: string) {
  return new Request(`https://alpha.workspaces.papercusp.com/api/hosted/connectors/socket?ticket=${ticket}`);
}

describe('HostedWorkspaceConnectorGateway',()=>{
  it('redeems enrollment once, authenticates the generation, and consumes session tickets once',async()=>{
    const gateway=new HostedWorkspaceConnectorGateway(new MemoryStore(),()=>new Date('2026-08-28T00:00:00Z'),entropy());
    const enrollment=await gateway.enroll(binding);
    const credential=await gateway.register(enrollment.ticket);
    expect(credential?.binding).toMatchObject({generation:1,state:'active'});
    expect(await gateway.register(enrollment.ticket)).toBeNull();
    expect(await gateway.authenticate(credential!.bearer)).toMatchObject({hostId:'host-1'});
    expect(await gateway.heartbeat(credential!.bearer,'sse')).toBeNull();
    expect(await gateway.heartbeat(credential!.bearer,'websocket')).toMatchObject({transport:'websocket'});
    const transportRequest=new Request('https://alpha.workspaces.papercusp.com/api/hosted/connectors/socket',{headers:{authorization:`Bearer ${credential!.bearer}`}});
    expect(await authenticateHostedConnectorTransport(gateway,transportRequest,'websocket')).toMatchObject({hostId:'host-1'});
    expect(await authenticateHostedConnectorTransport(gateway,transportRequest,'sse')).toBeNull();
    const session=await gateway.issueSessionTicket({...binding,generation:0,state:'pending',userId:'user-1',hostedSessionId:'session-1',audience:'workspace-operator'});
    expect(session?.binding).toMatchObject({generation:1,state:'active'});
    expect(await gateway.consumeSessionTicket(session!.ticket)).toMatchObject({userId:'user-1'});
    expect(await gateway.consumeSessionTicket(session!.ticket)).toBeNull();
  });

  it('closes old-generation streams on rotation and the current generation on revocation',async()=>{
    const gateway=new HostedWorkspaceConnectorGateway(new MemoryStore(),()=>new Date('2026-08-28T00:00:00Z'),entropy());
    const credential=await gateway.register((await gateway.enroll(binding)).ticket);
    const oldSession=await gateway.issueSessionTicket({...binding,generation:0,state:'pending',userId:'user-1',hostedSessionId:'session-1',audience:'workspace-operator'});
    const reasons:string[]=[]; gateway.track(credential!.binding,(reason)=>reasons.push(reason));
    const rotation=await gateway.rotate({...binding,routeLabel:'beta'});
    expect(reasons).toEqual(['connector_rotated']);
    expect(await gateway.consumeSessionTicket(oldSession!.ticket)).toBeNull();
    const next=await gateway.register(rotation!.ticket); gateway.track(next!.binding,(reason)=>reasons.push(reason));
    expect(await gateway.revoke(binding)).toBe(true);
    expect(reasons).toEqual(['connector_rotated','connector_revoked']);
    expect(await gateway.authenticate(next!.bearer)).toBeNull();
  });
});

describe('hosted browser WebSocket upgrade ticket rejection', () => {
  it('fails a syntactically valid but unknown ticket closed as unauthorized', async () => {
    const clock = { now: new Date('2026-08-28T00:00:00Z') };
    const gateway = await activeGateway(clock);

    await expect(
      authenticateHostedConnectorSocket(gateway, browserUpgrade(`ht_${'Z'.repeat(43)}`)),
    ).resolves.toBeNull();
  });

  it('fails an expired ticket closed as unauthorized without dereferencing it', async () => {
    const clock = { now: new Date('2026-08-28T00:00:00Z') };
    const gateway = await activeGateway(clock);
    const session = await gateway.issueSessionTicket({
      ...binding, generation: 0, state: 'pending', userId: 'user-1',
      hostedSessionId: 'session-expired', audience: 'workspace-operator',
    });
    clock.now = new Date('2026-08-28T00:01:01Z');

    await expect(
      authenticateHostedConnectorSocket(gateway, browserUpgrade(session!.ticket)),
    ).resolves.toBeNull();
  });

  it('fails a replayed one-time ticket closed as unauthorized', async () => {
    const clock = { now: new Date('2026-08-28T00:00:00Z') };
    const gateway = await activeGateway(clock);
    const session = await gateway.issueSessionTicket({
      ...binding, generation: 0, state: 'pending', userId: 'user-1',
      hostedSessionId: 'session-replay', audience: 'workspace-operator',
    });
    const request = browserUpgrade(session!.ticket);

    await expect(authenticateHostedConnectorSocket(gateway, request)).resolves.toMatchObject({
      role: 'browser',
      binding: { userId: 'user-1', hostedSessionId: 'session-replay' },
    });
    await expect(authenticateHostedConnectorSocket(gateway, request)).resolves.toBeNull();
  });

  it('fails a prior-generation ticket closed after connector rotation', async () => {
    const clock = { now: new Date('2026-08-28T00:00:00Z') };
    const gateway = await activeGateway(clock);
    const session = await gateway.issueSessionTicket({
      ...binding, generation: 0, state: 'pending', userId: 'user-1',
      hostedSessionId: 'session-stale-generation', audience: 'workspace-operator',
    });
    await gateway.rotate({ ...binding, routeLabel: 'beta' });

    await expect(
      authenticateHostedConnectorSocket(gateway, browserUpgrade(session!.ticket)),
    ).resolves.toBeNull();
  });
});
