// CoP and VoP responder (G confirmation-of-payee-responder, verification-of-payee-responder;
// decisions 808–810): LHV answers another bank's name check on an agency account itself,
// from what the agent synchronised (Name, AccountCategory, CopOptOut, Status), and tells
// the agent with a notification that carries both the request and the answer:
// CONFIRMATION_OF_PAYEE_INCOMING (UK CoP, sort code and account number) and
// VERIFICATION_OF_PAYEE_INCOMING_NOTIFICATION (SEPA VoP, IBAN). The scheme side is the
// simulator (/_sim/agency/cop-incoming, /vop-incoming).
import { randomUUID } from 'node:crypto'
import type { Clock } from '../clock.js'
import type { Bank } from '../payments/engine.js'
import type { Customer, Directory } from '../directory.js'
import type { InboxStore, Message } from '../inbox.js'
import { matchName } from '../payee/match.js'
import { COP_REASONS, VOP_REASONS } from '../payee/service.js'
import { rangeFor, type AccountCategory, type AgencyAccount, type AgencyStore } from './store.js'

export const COP_INCOMING = 'CONFIRMATION_OF_PAYEE_INCOMING'
export const VOP_INCOMING = 'VERIFICATION_OF_PAYEE_INCOMING_NOTIFICATION'

/** Texts of the G responder samples where they differ from the reason tables (decision 808). */
const COP_SAMPLE_REASONS: Record<string, string> = {
  MBAM: 'String is a close match to the account name',
  AC01: 'There is no account with the given account number.',
}
const CLOSE_COP = new Set(['MBAM', 'BAMM', 'PAMM'])

export interface ResponderDeps { directory: Directory; inbox: InboxStore; clock: Clock; store: AgencyStore; bank: Bank }

export interface CopIncoming {
  sortCode: string; accountNumber: string; name: string; classification: AccountCategory
  secondaryIdentification?: string; requesterBankName?: string
}
export interface VopIncoming { iban: string; name: string; bic?: string; requesterBic?: string }

/** What the simulator gets back: LHV's answer and the notification, if one was sent. */
export interface ResponderResult { body: Record<string, unknown>; agent?: Customer; account?: AgencyAccount; message?: Message }

export class AgencyResponder {
  constructor(private deps: ResponderDeps) {}

  /** The agent an account belongs to: its owner, else the agent whose agreement range covers it. */
  #agent(identifier: string, account?: AgencyAccount): Customer | undefined {
    if (account) return this.deps.directory.get(account.agent)
    return this.deps.directory.all().find((c) => rangeFor(c.agency, identifier) !== undefined)
  }

  async #notify(type: string, kind: 'cop' | 'vop', agent: Customer | undefined, body: object): Promise<Message | undefined> {
    if (!agent?.agency?.agreement || !agent.agency.notifications || !agent.agency[kind]) return undefined
    return this.deps.inbox.add({ customer: agent, type, body: JSON.stringify(body), contentType: 'application/json' })
  }

  /** An incoming CoP request on a sort code and account number of LHV UK (decision 808). */
  async cop(r: CopIncoming): Promise<ResponderResult> {
    const bban = `${r.sortCode}${r.accountNumber}`
    const account = this.deps.store.get('LHVUK', bban)
    const agent = this.#agent(bban, account)
    const now = this.deps.clock.now().toISOString()
    let code: string
    let actual: string | undefined
    if (!account || account.status === 'CLOSED') code = 'AC01'
    else if (!agent?.agency?.cop || !account.name) code = 'ACNS'
    else if (account.copOptOut) code = 'OPTO'
    else {
      const m = matchName(r.name, account.name)
      const held = account.category ?? r.classification
      const same = held === r.classification
      if (m === 'NONE') code = 'ANNM'
      else if (m === 'FULL') code = same ? 'ACCP' : held === 'BUSINESS' ? 'BANM' : 'PANM'
      else code = same ? 'MBAM' : held === 'BUSINESS' ? 'BAMM' : 'PAMM'
      if (CLOSE_COP.has(code)) actual = account.name
    }
    // A full match carries no reason (G "Full Match" sample: Status and Answer only).
    const reason = code === 'ACCP' ? undefined : COP_SAMPLE_REASONS[code] ?? COP_REASONS[code].replace('(...)', actual ?? '(...)')
    const body = {
      Request: {
        ...(r.requesterBankName ? { DebtorParty: { AccountWith: { BankName: r.requesterBankName } } } : {}),
        Data: [{
          Id: randomUUID(), CreatedOn: now,
          Attributes: {
            AccountClassification: r.classification, AccountNumber: r.accountNumber, AccountNumberCode: 'BBAN',
            BankId: r.sortCode, BankIdCode: 'GBDSC', Name: [r.name],
            ...(r.secondaryIdentification !== undefined ? { SecondaryIdentification: r.secondaryIdentification } : {}),
          },
        }],
      },
      Response: {
        Data: {
          Attributes: {
            Status: 'confirmed', Answer: code === 'ACCP' ? 'CONFIRMED' : 'REJECTED',
            ...(actual ? { ActualName: actual } : {}),
            ...(reason ? { ReasonCode: code, Reason: reason } : {}),
          },
        },
      },
    }
    return { body, agent, account, message: await this.#notify(COP_INCOMING, 'cop', agent, body) }
  }

  /** An incoming VoP request on an IBAN synchronised with LHV EE or LHV UK (decision 809). */
  async vop(r: VopIncoming): Promise<ResponderResult> {
    const account = this.deps.store.find(r.iban)[0]
    const agent = this.#agent(r.iban, account)
    const now = this.deps.clock.now().toISOString()
    let code: string
    let actual: string | undefined
    if (!account || account.status === 'CLOSED' || !agent?.agency?.vop || !account.name) code = 'NOAP'
    else {
      code = { FULL: 'MTCH', CLOSE: 'CMTC', NONE: 'NMTC' }[matchName(r.name, account.name)]
      // The G samples give ActualName with a full match too, not with no match.
      if (code !== 'NMTC') actual = account.name
    }
    const range = agent ? rangeFor(agent.agency, r.iban) : undefined
    const body = {
      Request: {
        Data: [{
          Attributes: {
            AccountNumber: r.iban, AccountNumberCode: 'IBAN', BankId: r.bic ?? range?.bic ?? `${this.deps.bank.bic}XXX`.slice(0, 11), BankIdCode: 'SWBIC',
            Name: [r.name], RequestDtime: now, RequesterBankId: r.requesterBic ?? 'DEUTDEFFXXX',
          },
          CreatedOn: now, Id: randomUUID(),
        }],
      },
      Response: {
        Data: {
          Attributes: {
            Answer: code === 'MTCH' ? 'CONFIRMED' : 'REJECTED',
            ...(actual ? { ActualName: actual } : {}),
            Reason: code === 'CMTC' ? VOP_REASONS.CMTC.replace('(...)', `(${actual})`) : VOP_REASONS[code],
            ReasonCode: code,
            Status: 'confirmed',
          },
        },
      },
    }
    return { body, agent, account, message: await this.#notify(VOP_INCOMING, 'vop', agent, body) }
  }
}
