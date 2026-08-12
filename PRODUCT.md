# Product

## Register

product

## Users

Internal auditors, controllers and accounting staff at small and mid-size firms,
plus the one finance person at a company too small to have a department.

Their context is the monthly close, on a corporate laptop they do not have admin
rights to. They have an expense report of 40 to 350 rows and a folder of receipt
PDFs, and a partner or manager who will ask "why was this one flagged?" and
expects an answer with a number in it.

The job to be done: turn a spreadsheet and a pile of PDFs into a defensible
exception list, without the client's financial records leaving the building and
without asking IT to install anything.

## Product Purpose

Receipt Recon matches every row of an expense report to its support document,
applies a fixed ruleset, and produces an Excel workbook stating what is wrong,
why, and which receipt proves it.

Extraction is the only job given to a model. Everything downstream is plain
deterministic code, so the same inputs produce the same findings and the same
SHA-256 run hash every time.

Success looks like an auditor re-running last month and getting last month's
answer, then defending any single row of it from the evidence on screen.

## Brand Personality

Sober, exact, unbluffing.

The voice is a working instrument, not a product pitch. It states what it
checked, what it could not read, and what it did not verify. It never rounds a
finding up to a conclusion, and it says "check this one yourself" out loud
rather than guessing.

Emotionally the target is earned trust: a tool an accountant is comfortable
putting on a screen share with a partner watching.

## Anti-references

- **Cloud AI expense dashboards** that return "this looks fine" with no rule,
  no threshold, and no way to reproduce the answer next month.
- **Chat-shaped interfaces** for a task that is arithmetic and table lookups.
- **Consumer fintech**: gradients, oversized rounded cards, celebratory
  animation, currency figures treated as a design element.
- **SaaS marketing shell around a thin tool.** The page is the tool. There is no
  pricing section, no testimonial, no logo wall.
- **Anything that hides its uncertainty.** A confidence score that is never shown
  is worse than no score.

## Design Principles

1. **Show the evidence, not a verdict about it.** Every finding puts the
   triggering value, the threshold and the source receipt within one click.
2. **Reproducible beats impressive.** Where a flourish and a fixed, checkable
   output conflict, the output wins.
3. **Admit what you could not read.** Unreadable is a first-class result with its
   own tier, never a silent pass and never a guess.
4. **Survive the locked-down laptop.** No install, no account, no CDN, no
   outbound request. Constraints of the worst-case machine set the design.
5. **Density is a service.** The user is scanning hundreds of rows in a task.
   Earned familiarity and information density beat novelty.

## Accessibility & Inclusion

- **WCAG 2.2 AA** is the floor. Text meets 4.5:1, large text 3:1, and every
  contrast rung is checked against the darkest surface it actually sits on.
- **Full keyboard parity.** Every task the mouse can do, including loading files
  and opening receipt evidence, is reachable and operable from the keyboard with
  a visible focus indicator.
- **Reduced motion is honoured** for transitions and for programmatic scrolling.
- **Colour is never the only signal.** Severity carries a rule code and a text
  label alongside its colour, so the exception tiers survive colour blindness and
  a black-and-white print of the workbook.
- **Theme is the user's choice**, following the system by default with a manual
  light and dark override that persists.
