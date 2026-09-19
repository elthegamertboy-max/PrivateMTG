function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function getRolesForPlayerCount(count) {
  if (roleDistribution[count]) {
    return [...roleDistribution[count]];
  }
  // Moins de 4 joueurs (ou cas non prévu) : pas de vraie répartition,
  // juste de quoi ne pas planter, en cyclant sur les catégories connues.
  const categories = Object.keys(treacheryCards);
  const roles = [];
  for (let i = 0; i < count; i++) {
    roles.push(categories[i % categories.length]);
  }
  return roles;
}

async function iniRoles() {
  if (!game.isHost) return
  const totalPlayers = game.turn.totalPlayers;
  const roles = shuffleArray(getRolesForPlayerCount(totalPlayers));

  const availableIdsByCategory = {};
  for (const category of Object.keys(treacheryCards)) {
    availableIdsByCategory[category] = shuffleArray(treacheryCards[category]);
  }

  const playerRoleCards = [];
  for (let i = 0; i < totalPlayers; i++) {
    const type = roles[i];
    const pool = availableIdsByCategory[type];
    const id = pool && pool.length > 0 ? pool.pop() : null;
    playerRoleCards.push({ id, type });
  }

  game.data.IdentityManager.playerRoleCards = playerRoleCards;
}

async function createRoleCard() {
  const myIndex = game.turn.orderPosition
  const myCard = game.data.IdentityManager.playerRoleCards[myIndex]
  if (!myCard) return
  const c = await functions.createCard("treachery-" + myCard.id, "Identity")
  if (myCard.type === "Leader") {
    await functions.updateCards([c], { hiddenTo: { "status": "no" } })
  }
  await functions.updateCards([c], { owner: game.playerId })
  await functions.repositionCards()
}

async function tryCreateRoleCard() {
  if (game.data.MyIdentity?.hasRoleBeenCreated) return
  if (!game.data.MyIdentity?.playersReady) return
  const roleCards = game.data.IdentityManager?.playerRoleCards
  if (!roleCards || roleCards.length === 0) return

  await createRoleCard()
  game.data.MyIdentity.hasRoleBeenCreated = true
}

async function revealRole() {
  if (cards?.Identity?.length === 0) return
  const myCard = cards?.Identity[0]
  await functions.updateCards([myCard], { hiddenTo: { "status": "no" } })
  await functions.createCardEffect(myCard)
}


const roleDistribution = {
  1: ["Leader"],
  2: ["Leader", "Traitor"],
  3: ["Leader", "Traitor", "Assassin"],
  4: ["Leader", "Traitor", "Assassin", "Assassin"],
  5: ["Leader", "Traitor", "Assassin", "Assassin", "Guardian"],
};

const treacheryCards = {
  "Guardian": [
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9",
    "10",
    "11",
    "12",
    "13",
    "14",
    "15",
    "16",
    "17",
    "18"
  ],
  "Traitor": [
    "19",
    "20",
    "21",
    "22",
    "23",
    "24",
    "25",
    "26",
    "27",
    "28",
    "29",
    "30"
  //  "31" wearer of mask
  ],
  "Assassin": [
    "32",
    "33",
    "34",
    "35",
    "36",
    "37",
    "38",
    "39",
    "40",
    "41",
    "42",
    "43",
    "44",
    "45",
    "46",
    "47",
    "48",
    "49"
  ],
  "Leader": [
    "50",
    "51",
    "52",
    "53",
    "54",
    "55",
    "56",
    "57",
    "58",
    "59",
    "60",
    "61",
    "62"
  ]
}