# Pehla din — technology nahi jaante toh yahan se shuru karo

[Book](../MADHURITA_BUILD_BOOK.md)

## Hum kya bana rahe hain?

Madhurita ek software saathi hai. Tum usko kaam doge; woh notebook mein kaam likhegi, available tools se karegi, result check karegi aur tumhe dikhayegi. Sirf "kar diya" bolna kaam nahi hai. Yeh book v3 hai — LLM-agnostic (model badlo, architecture nahi), har click body ko pata, aur seekhna = tested skill, not weight training.

Is book ko padhkar complete beginner ko project samajh aana chahiye. Lekin programming seekhe bina akele production software banana ya kisi bhi agent se flawless result paana guarantee nahi hai. Tests, review aur kabhi experienced help chahiye hogi. Book confusion kam karti hai; technical skill aur hardware create nahi karti.

## Chhoti dictionary

- Repository: project ka folder aur uski history.
- File: ek page. Code wali file machine ko kaam samjhati hai.
- Terminal: woh window jahan commands likhte hain.
- Node: is project ka server chalane wala program.
- npm: project ki listed libraries aur scripts chalata hai.
- Server: workshop jahan actual kaam hota hai.
- Browser/UI: workshop ki window jo tum dekhte ho.
- Database: permanent notebook, jo restart ke baad bhi bachti hai.
- API: do parts ke beech labeled darwaza.
- Model/Faculty: language/reasoning engine, poora application nahi. Provider badal sakte ho, par interface ek hi hai.
- Faculty modes: `local-only` (no paid), `hybrid` (local + allowed quota), `quality` (owner approves paid).
- Test: chhota experiment jo expected result check karta hai.
- Commit: changes ka saved history point. Merge: reviewed changes ko main version mein lana.
- Checkpoint: agla kaam kahan se shuru karna hai.

## Agar tum agent se banwa rahe ho

Yeh instruction do — yeh v3 ke liye verified hai:

> `docs/MADHURITA_BUILD_BOOK.md` aur `docs/guide/00-START.md` padho. `docs/build/PLAN.json` aur `docs/build/CHECKPOINT.json` se pehla eligible slice lo. Current files verify karo, failing test banao, smallest implementation karo, checks chalao aur evidence save karo. B07 truncated nahi hai, B08–B11 maujood hain, Faculty seam `server/llm/provider.ts` hai, UI projection-only hai. Puri book ek prompt mein mat bharo. Expected behavior badalna, fake success, paid fallback aur owner data delete karna allowed nahi. Session khatam ho toh exact resume checkpoint do. `git reset --hard` / `git clean -fd` kabhi mat chalao. Commit/push/merge meri authorization ke hisaab se hi karo.

Agent ko actual repository access, terminal/test execution aur enough compute chahiye. Sirf chat mein pasted code se project verified nahi hota. Kisi instruction file ko system/platform restrictions bypass karne ka adhikar nahi.

**Is branch par kya naya hai:** `docs-rewrite` branch ne B07 ko fix kiya, B08–B11 banaye, aur 01/02/04/05/06 ko v3 ke mutabiq augment kiya. Koi application code change nahi — sirf docs.

## Agar tum computer par project chalana chahte ho

1. Project ki working copy lo. Existing data/settings ka backup rakho. Fresh folder aur real owner database ko confuse mat karo. `git reset --hard` mat chalao — kuch files sirf index mein thi.
2. Trusted Node installation use karo; required version `.nvmrc` mein dekho. Commands OS ke terminal mein project folder se chalti hain.
3. `node --version` aur `npm --version` se installation check karo.
4. `npm ci` se lockfile ke dependencies install karo. Error aaye toh uska exact text save karo; random packages install mat karo.
5. `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` ek-ek chalao. Har command ka exit code/result note karo.
6. `.env.example` samjho — `FACULTY_MODE` / `LLM_PROVIDER` ab v3 mein hain. Existing `.env` overwrite mat karo. API key public chat, screenshot ya commit mein mat daalo.
7. `npm start` chalao. Terminal jo local address bataye browser mein kholo. Terminal/server band karoge toh background compute nahi chalega. Future mein Mac par `scripts/launchd/` se auto-start hoga (abhi optional).

Yeh existing commands hain. Naye task cards mein proposed scripts jab tak banaye nahi gaye, tab tak commands ki tarah use mat karo. Red test ka matlab automatically tumhari galti nahi; B00 baseline identify karega.

## Kaise pata chalega kitna bana?

PLAN = kaam ka order (`specVersion: "3"`). CHECKPOINT = abhi wali jagah (`B00/s1` se start). Evidence = test ne kya dikhaya. Inventory = dated summary. In chaaron ko ek hi cheez mat samjho.

"Completed" likha ho par evidence missing ho toh verified nahi. "Tests pass" ho par actual voice nahi suni gayi toh voice quality unknown. Sirf model connected ho toh autonomous work ready nahi.

## Har milestone par agent se yeh maango

Kya naya kaam sach mein hua? Kaunsa test usko prove karta hai? Kaunsa revision test hua? Kya nahi hua? Agla exact slice kya hai? Agar blocked hai toh tumse kaunsi ek decision chahiye?

Pehla target: apne supplied documents se ek real brief banana, save karna, dikhana aur restart ke baad continue karna. Jab yeh reliable ho, tab web sources, richer voice aur more skills jodo. Isse original AIM chhota nahi hota; us tak pahunchne ka rasta checkable hota hai.

**Mac par aage kya hoga (abhi non-goal):** launchd se survive reboot, phir menu bar, hotkey, aur Siri bridge — `server/` code bina badle. Details Build Book ke Mac roadmap mein hain.
