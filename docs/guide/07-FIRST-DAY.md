# Pehla din — technology nahi jaante toh yahan se shuru karo

[Book](../MADHURITA_BUILD_BOOK.md)

## Hum kya bana rahe hain?

Madhurita ek software saathi hai. Tum usko kaam doge; woh notebook mein kaam likhegi, available tools se karegi, result check karegi aur tumhe dikhayegi. Sirf “kar diya” bolna kaam nahi hai.

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
- Model: language/reasoning engine, poora application nahi.
- Test: chhota experiment jo expected result check karta hai.
- Commit: changes ka saved history point. Merge: reviewed changes ko main version mein lana.
- Checkpoint: agla kaam kahan se shuru karna hai.

## Agar tum agent se banwa rahe ho

Yeh instruction do:

> docs/MADHURITA_BUILD_BOOK.md aur docs/guide/00-START.md padho. PLAN aur CHECKPOINT se pehla eligible slice lo. Current files verify karo, failing test banao, smallest implementation karo, checks chalao aur evidence save karo. Puri book ek prompt mein mat bharo. Expected behavior badalna, fake success, paid fallback aur owner data delete karna allowed nahi. Session khatam ho toh exact resume checkpoint do. Commit/push/merge meri authorization ke hisaab se hi karo.

Agent ko actual repository access, terminal/test execution aur enough compute chahiye. Sirf chat mein pasted code se project verified nahi hota. Kisi instruction file ko system/platform restrictions bypass karne ka adhikar nahi.

## Agar tum computer par project chalana chahte ho

1. Project ki working copy lo. Existing data/settings ka backup rakho. Fresh folder aur real owner database ko confuse mat karo.
2. Trusted Node installation use karo; required version `.nvmrc` mein dekho. Commands OS ke terminal mein project folder se chalti hain.
3. `node --version` aur `npm --version` se installation check karo.
4. `npm ci` se lockfile ke dependencies install karo. Error aaye toh uska exact text save karo; random packages install mat karo.
5. `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` ek-ek chalao. Har command ka exit code/result note karo.
6. `.env.example` samjho. Existing `.env` overwrite mat karo. API key public chat, screenshot ya commit mein mat daalo.
7. `npm start` chalao. Terminal jo local address bataye browser mein kholo. Terminal/server band karoge toh background compute nahi chalega.

Yeh existing commands hain. Naye task cards mein proposed scripts jab tak banaye nahi gaye, tab tak commands ki tarah use mat karo. Red test ka matlab automatically tumhari galti nahi; B00 baseline identify karega.

## Kaise pata chalega kitna bana?

PLAN = kaam ka order. CHECKPOINT = abhi wali jagah. Evidence = test ne kya dikhaya. Inventory = dated summary. In chaaron ko ek hi cheez mat samjho.

“Completed” likha ho par evidence missing ho toh verified nahi. “Tests pass” ho par actual voice nahi suni gayi toh voice quality unknown. Sirf model connected ho toh autonomous work ready nahi.

## Har milestone par agent se yeh maango

Kya naya kaam sach mein hua? Kaunsa test usko prove karta hai? Kaunsa revision test hua? Kya nahi hua? Agla exact slice kya hai? Agar blocked hai toh tumse kaunsi ek decision chahiye?

Pehla target: apne supplied documents se ek real brief banana, save karna, dikhana aur restart ke baad continue karna. Jab yeh reliable ho, tab web sources, richer voice aur more skills jodo. Isse original AIM chhota nahi hota; us tak pahunchne ka rasta checkable hota hai.
