import React, { useEffect, useMemo, useState } from "react";

const MIN_PLAYERS = 3;
const MAX_PLAYERS = 6;
const VIEW_MODE_STORAGE_KEY = "bondebridge.viewMode.v1";
const ACCOUNTS_STORAGE_KEY = "bondebridge.accounts.v1";
const ACTIVE_USER_STORAGE_KEY = "bondebridge.activeUser.v1";

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function getMaxCardsPerPlayer(playerCount) {
  return Math.floor(52 / playerCount);
}

function getCardFlowFromPeak(peakCards) {
  const down = Array.from({ length: peakCards }, (_, i) => peakCards - i);
  const up = Array.from({ length: peakCards }, (_, i) => i + 1);
  return [...down, ...up];
}

function pointsForRound(bid, stood) {
  if (bid === "" || bid === null || bid === undefined) return 0;
  const bidNumber = Number(bid);
  if (Number.isNaN(bidNumber) || !stood) return 0;
  if (bidNumber === 0) return 5;
  return 10 + bidNumber * bidNumber;
}

function buildScoreSummary(rounds, players) {
  const statsMap = Object.fromEntries(
    players.map((player) => [
      player.seatId,
      {
        basePoints: 0,
        streakPenalty: 0,
        warningPenalty: 0,
        warnings: 0,
        total: 0,
        currentMissedInRow: 0,
        latestPenaltyLevel: 0,
      },
    ])
  );

  const streakState = Object.fromEntries(players.map((player) => [player.seatId, 0]));
  const warningState = Object.fromEntries(players.map((player) => [player.seatId, 0]));

  const roundRows = rounds.map((round) => {
    const row = {
      id: round.id,
      number: round.number,
      cards: round.cards,
      values: {},
    };

    players.forEach((player) => {
      const basePoints = pointsForRound(round.bids[player.seatId], round.stood[player.seatId]);
      const stood = round.stood[player.seatId];
      const warningsInRound = Number(round.warnings?.[player.seatId] || 0);
      let streakPenaltyDelta = 0;
      let streakTriggerLevel = 0;

      if (stood) {
        streakState[player.seatId] = 0;
      } else {
        streakState[player.seatId] += 1;
        if (streakState[player.seatId] === 3) {
          streakPenaltyDelta -= 10;
          streakTriggerLevel = 3;
        }
        if (streakState[player.seatId] === 6) {
          streakPenaltyDelta -= 30;
          streakTriggerLevel = 6;
        }
      }

      const previousWarningPenalty = Math.floor(warningState[player.seatId] / 2) * -10;
      warningState[player.seatId] += warningsInRound;
      const nextWarningPenalty = Math.floor(warningState[player.seatId] / 2) * -10;
      const warningPenaltyDelta = nextWarningPenalty - previousWarningPenalty;
      const totalDelta = basePoints + streakPenaltyDelta + warningPenaltyDelta;

      statsMap[player.seatId].basePoints += basePoints;
      statsMap[player.seatId].streakPenalty += streakPenaltyDelta;
      statsMap[player.seatId].warningPenalty = nextWarningPenalty;
      statsMap[player.seatId].warnings = warningState[player.seatId];
      statsMap[player.seatId].total += totalDelta;
      statsMap[player.seatId].currentMissedInRow = streakState[player.seatId];
      if (streakTriggerLevel) {
        statsMap[player.seatId].latestPenaltyLevel = streakTriggerLevel;
      }

      row.values[player.seatId] = {
        basePoints,
        streakPenaltyDelta,
        warningPenaltyDelta,
        totalDelta,
        streakTriggerLevel,
        currentMissedInRow: streakState[player.seatId],
      };
    });

    return row;
  });

  return { statsMap, roundRows };
}

function computeOverUnder(totalBids, cards) {
  const delta = totalBids - cards;
  if (delta === 0) {
    return {
      delta,
      tone: "neutral",
      signed: "0",
      label: "Ulovlig: summen kan ikke være lik antall kort",
    };
  }
  if (delta > 0) {
    return {
      delta,
      tone: "over",
      signed: `+${delta}`,
      label: `Overmeldt med ${delta}`,
    };
  }
  return {
    delta,
    tone: "under",
    signed: `-${Math.abs(delta)}`,
    label: `Undermeldt med ${Math.abs(delta)}`,
  };
}

function createSessionPlayers(count, previous = []) {
  return Array.from({ length: count }, (_, index) => {
    const prior = previous[index];
    const fallbackName = `Spiller ${index + 1}`;
    return {
      seatId: `seat-${index + 1}`,
      name: prior?.name || fallbackName,
      avatar: prior?.avatar || "",
      savedPlayerId: prior?.savedPlayerId || null,
    };
  });
}

function buildRounds(cardsFlow, players, previousRounds = []) {
  return cardsFlow.map((cards, index) => {
    const previous = previousRounds[index];
    const bids = { ...(previous?.bids || {}) };
    const stood = { ...(previous?.stood || {}) };
    const warnings = { ...(previous?.warnings || {}) };

    players.forEach((player) => {
      if (!(player.seatId in bids)) bids[player.seatId] = "";
      if (!(player.seatId in stood)) stood[player.seatId] = true;
      if (!(player.seatId in warnings)) warnings[player.seatId] = 0;
    });

    return {
      id: `r-${index + 1}`,
      number: index + 1,
      cards,
      bids,
      stood,
      warnings,
    };
  });
}

function createDefaultGameState(playerCount = 4) {
  const basePlayers = createSessionPlayers(playerCount);
  const peakCards = getMaxCardsPerPlayer(playerCount);
  return {
    phase: "setup",
    playerCount,
    players: basePlayers,
    peakCards,
    roundIndex: 0,
    rounds: buildRounds(getCardFlowFromPeak(peakCards), basePlayers),
    savedPlayers: [],
  };
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(new Error("Kunne ikke lese filen"));
    reader.readAsDataURL(file);
  });
}

function loadAccounts() {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(ACCOUNTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item) =>
        item &&
        typeof item.username === "string" &&
        typeof item.pin === "string"
    );
  } catch {
    return [];
  }
}

function loadActiveUser() {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(ACTIVE_USER_STORAGE_KEY) || "";
}

function findAccount(accounts, username) {
  const normalized = username.trim().toLowerCase();
  return accounts.find(
    (account) => account.username.trim().toLowerCase() === normalized
  );
}

function getUserDataKey(username) {
  return `bondebridge.user.${username.trim().toLowerCase()}`;
}

function loadUserData(username) {
  if (typeof window === "undefined" || !username) return null;
  try {
    const raw = window.localStorage.getItem(getUserDataKey(username));
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveUserData(username, data) {
  if (typeof window === "undefined" || !username) return;
  window.localStorage.setItem(getUserDataKey(username), JSON.stringify(data));
}

function loadViewMode() {
  if (typeof window === "undefined") return "desktop";
  const saved = window.localStorage.getItem(VIEW_MODE_STORAGE_KEY);
  return saved === "tablet" ? "tablet" : "desktop";
}

function ViewModeToggle({ viewMode, onChange }) {
  return (
    <div className="view-mode-toggle" aria-label="Velg visning">
      <button
        type="button"
        className={viewMode === "desktop" ? "active" : ""}
        onClick={() => onChange("desktop")}
        aria-label="Desktop-visning"
        title="Desktop-visning"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="3" y="4" width="18" height="12" rx="2" />
          <path d="M9 20h6" />
          <path d="M12 16v4" />
        </svg>
      </button>
      <button
        type="button"
        className={viewMode === "tablet" ? "active" : ""}
        onClick={() => onChange("tablet")}
        aria-label="iPad-visning"
        title="iPad-visning"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="6" y="2.5" width="12" height="19" rx="2.5" />
          <circle cx="12" cy="18.5" r="0.8" fill="currentColor" stroke="none" />
        </svg>
      </button>
    </div>
  );
}

function validateSetup(players, peakCards) {
  if (players.length < MIN_PLAYERS || players.length > MAX_PLAYERS) {
    return { valid: false, message: "Velg mellom 3 og 6 spillere." };
  }

  if (peakCards < 1) {
    return { valid: false, message: "Velg minst 1 kort i rundeoppsettet." };
  }

  const invalidPeak = peakCards * players.length > 52;
  if (invalidPeak) {
    return {
      valid: false,
      message: `${peakCards} kort per spiller med ${players.length} spillere overstiger 52 kort.`,
    };
  }

  return { valid: true, message: "Oppsettet er gyldig. Klar for spillstart." };
}

function isUnassignedSeat(player, seatIndex) {
  const defaultName = `Spiller ${seatIndex + 1}`;
  return !player.savedPlayerId && !player.avatar && player.name.trim() === defaultName;
}

function shouldShowSaveButton(player, seatIndex, savedPlayers) {
  const trimmedName = player.name.trim();
  if (!trimmedName) return false;
  if (player.savedPlayerId) return false;
  if (isUnassignedSeat(player, seatIndex)) return false;

  const alreadyExists = savedPlayers.some((saved) => {
    const sameName = saved.name.trim().toLowerCase() === trimmedName.toLowerCase();
    const sameAvatar = (saved.avatar || "") === (player.avatar || "");
    return sameName && sameAvatar;
  });

  return !alreadyExists;
}

export default function App() {
  const [viewMode, setViewMode] = useState(() => loadViewMode());
  const [accounts, setAccounts] = useState(() => loadAccounts());
  const [currentUser, setCurrentUser] = useState(() => loadActiveUser());
  const [authMode, setAuthMode] = useState("login");
  const [authName, setAuthName] = useState("");
  const [authPin, setAuthPin] = useState("");
  const [authError, setAuthError] = useState("");
  const [hasLoadedUserData, setHasLoadedUserData] = useState(false);
  const [phase, setPhase] = useState("setup");
  const [playerCount, setPlayerCount] = useState(4);
  const [players, setPlayers] = useState(() => createSessionPlayers(4));
  const [peakCards, setPeakCards] = useState(getMaxCardsPerPlayer(4));
  const [roundIndex, setRoundIndex] = useState(0);
  const [savedPlayers, setSavedPlayers] = useState([]);
  const [newPlayerName, setNewPlayerName] = useState("");
  const [newPlayerAvatar, setNewPlayerAvatar] = useState("");
  const [dragSeatId, setDragSeatId] = useState(null);
  const [dragOverSeatId, setDragOverSeatId] = useState(null);
  const [dropPosition, setDropPosition] = useState("before");
  const [showAllRounds, setShowAllRounds] = useState(false);
  const availableSavedPlayers = useMemo(() => {
    const assignedIds = new Set(
      players.map((player) => player.savedPlayerId).filter(Boolean)
    );
    return savedPlayers.filter((saved) => !assignedIds.has(saved.id));
  }, [players, savedPlayers]);

  const cardsFlow = useMemo(() => getCardFlowFromPeak(peakCards), [peakCards]);
  const [rounds, setRounds] = useState(() => buildRounds(getCardFlowFromPeak(13), createSessionPlayers(4)));

  const setupValidation = useMemo(() => validateSetup(players, peakCards), [players, peakCards]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, viewMode);
  }, [viewMode]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(ACCOUNTS_STORAGE_KEY, JSON.stringify(accounts));
  }, [accounts]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (currentUser) {
      window.localStorage.setItem(ACTIVE_USER_STORAGE_KEY, currentUser);
    } else {
      window.localStorage.removeItem(ACTIVE_USER_STORAGE_KEY);
    }
  }, [currentUser]);

  useEffect(() => {
    if (!currentUser) {
      const fallbackState = createDefaultGameState();
      setPhase(fallbackState.phase);
      setPlayerCount(fallbackState.playerCount);
      setPlayers(fallbackState.players);
      setPeakCards(fallbackState.peakCards);
      setRoundIndex(fallbackState.roundIndex);
      setRounds(fallbackState.rounds);
      setSavedPlayers(fallbackState.savedPlayers);
      setHasLoadedUserData(false);
      return;
    }

    const stored = loadUserData(currentUser);
    const fallbackState = createDefaultGameState();
    const nextState = {
      ...fallbackState,
      ...(stored || {}),
    };

    setPhase(nextState.phase || "setup");
    setPlayerCount(
      clamp(Number(nextState.playerCount || fallbackState.playerCount), MIN_PLAYERS, MAX_PLAYERS)
    );
    setPlayers(
      Array.isArray(nextState.players) && nextState.players.length
        ? nextState.players
        : fallbackState.players
    );
    setPeakCards(Number(nextState.peakCards || fallbackState.peakCards));
    setRoundIndex(Number(nextState.roundIndex || 0));
    setRounds(
      Array.isArray(nextState.rounds) && nextState.rounds.length
        ? nextState.rounds
        : fallbackState.rounds
    );
    setSavedPlayers(
      Array.isArray(nextState.savedPlayers) ? nextState.savedPlayers : fallbackState.savedPlayers
    );
    setHasLoadedUserData(true);
  }, [currentUser]);

  useEffect(() => {
    if (!currentUser || !hasLoadedUserData) return;
    saveUserData(currentUser, {
      phase,
      playerCount,
      players,
      peakCards,
      roundIndex,
      rounds,
      savedPlayers,
    });
  }, [
    currentUser,
    hasLoadedUserData,
    phase,
    playerCount,
    players,
    peakCards,
    roundIndex,
    rounds,
    savedPlayers,
  ]);

  const scoreSummary = useMemo(() => {
    if (phase !== "game") {
      return {
        statsMap: Object.fromEntries(
          players.map((player) => [
            player.seatId,
            { basePoints: 0, streakPenalty: 0, warningPenalty: 0, warnings: 0, total: 0 },
          ])
        ),
        roundRows: [],
      };
    }
    return buildScoreSummary(rounds, players);
  }, [phase, players, rounds]);

  const playerStats = scoreSummary.statsMap;
  const roundScoreRows = scoreSummary.roundRows;
  const recentRoundRows = roundScoreRows.slice(-5).reverse();

  const currentRound = rounds[roundIndex];
  const totalBids = currentRound
    ? players.reduce((sum, player) => sum + Number(currentRound.bids[player.seatId] || 0), 0)
    : 0;
  const overUnder = currentRound
    ? computeOverUnder(totalBids, currentRound.cards)
    : { delta: 0, tone: "neutral", signed: "0", label: "" };

  const changePlayerCount = (nextCount) => {
    if (phase !== "setup") return;
    const clamped = clamp(Number(nextCount), MIN_PLAYERS, MAX_PLAYERS);
    setPlayerCount(clamped);
    setPlayers((previous) => createSessionPlayers(clamped, previous));
    setPeakCards(getMaxCardsPerPlayer(clamped));
  };

  const updatePlayerAtSeat = (seatId, patch) => {
    setPlayers((previous) =>
      previous.map((player) =>
        player.seatId === seatId
          ? {
              ...player,
              ...patch,
            }
          : player
      )
    );
  };

  const clearSeat = (seatId) => {
    setPlayers((previous) =>
      previous.map((player, index) =>
        player.seatId === seatId
          ? {
              ...player,
              name: `Spiller ${index + 1}`,
              avatar: "",
              savedPlayerId: null,
            }
          : player
      )
    );
  };

  const onSeatDragStart = (seatId, event) => {
    if (phase !== "setup") return;
    setDragSeatId(seatId);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", seatId);
  };

  const onSeatDragOver = (targetSeatId, event) => {
    if (phase !== "setup") return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    if (!dragSeatId || dragSeatId === targetSeatId) {
      setDragOverSeatId(null);
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();
    const midpoint = rect.top + rect.height / 2;
    const nextDropPosition = event.clientY > midpoint ? "after" : "before";
    setDropPosition(nextDropPosition);
    setDragOverSeatId(targetSeatId);
  };

  const onSeatDrop = (targetSeatId, event) => {
    if (phase !== "setup") return;
    event.preventDefault();
    const sourceSeatId = dragSeatId || event.dataTransfer.getData("text/plain");
    if (!sourceSeatId || sourceSeatId === targetSeatId) {
      setDragSeatId(null);
      setDragOverSeatId(null);
      return;
    }

    setPlayers((previous) => {
      const sourceIndex = previous.findIndex((player) => player.seatId === sourceSeatId);
      const targetIndex = previous.findIndex((player) => player.seatId === targetSeatId);
      if (sourceIndex < 0 || targetIndex < 0) return previous;
      const next = [...previous];
      const [moved] = next.splice(sourceIndex, 1);
      let insertIndex = targetIndex + (dropPosition === "after" ? 1 : 0);
      if (sourceIndex < insertIndex) insertIndex -= 1;
      next.splice(insertIndex, 0, moved);
      return next;
    });
    setDragSeatId(null);
    setDragOverSeatId(null);
  };

  const onSeatDragEnd = () => {
    setDragSeatId(null);
    setDragOverSeatId(null);
  };

  const applySavedPlayerToSeat = (seatId, savedPlayer) => {
    updatePlayerAtSeat(seatId, {
      name: savedPlayer.name,
      avatar: savedPlayer.avatar || "",
      savedPlayerId: savedPlayer.id,
    });
  };

  const removeSavedPlayer = (savedId) => {
    setSavedPlayers((previous) => previous.filter((player) => player.id !== savedId));
  };

  const addPlayerToLibrary = () => {
    const trimmed = newPlayerName.trim();
    if (!trimmed) return;
    const newSaved = {
      id: `sp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: trimmed,
      avatar: newPlayerAvatar,
    };
    setSavedPlayers((previous) => [newSaved, ...previous]);
    setNewPlayerName("");
    setNewPlayerAvatar("");
  };

  const onUploadNewAvatar = async (file) => {
    if (!file) return;
    const dataUrl = await readFileAsDataUrl(file);
    setNewPlayerAvatar(dataUrl);
  };

  const onUploadSeatAvatar = async (seatId, file) => {
    if (!file) return;
    const dataUrl = await readFileAsDataUrl(file);
    updatePlayerAtSeat(seatId, { avatar: dataUrl, savedPlayerId: null });
  };

  const saveSeatAsLibraryPlayer = (player) => {
    const trimmed = player.name.trim();
    if (!trimmed) return;
    const newSaved = {
      id: `sp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: trimmed,
      avatar: player.avatar || "",
    };
    setSavedPlayers((previous) => [newSaved, ...previous]);
  };

  const startGame = () => {
    if (!setupValidation.valid) return;
    const normalizedPlayers = players.map((player, index) => ({
      ...player,
      name: player.name.trim() || `Spiller ${index + 1}`,
    }));
    const nextRounds = buildRounds(cardsFlow, normalizedPlayers);
    setPlayers(normalizedPlayers);
    setRounds(nextRounds);
    setRoundIndex(0);
    setShowAllRounds(false);
    setPhase("game");
  };

  const backToSetup = () => {
    setPhase("setup");
    setRoundIndex(0);
    setShowAllRounds(false);
    setRounds(buildRounds(cardsFlow, players));
  };

  const updateRoundField = (seatId, field, value) => {
    if (phase !== "game") return;
    setRounds((previous) =>
      previous.map((round, index) => {
        if (index !== roundIndex) return round;
        return {
          ...round,
          [field]: {
            ...round[field],
            [seatId]: value,
          },
        };
      })
    );
  };

  const submitAuth = () => {
    const username = authName.trim();
    const pin = authPin.trim();

    if (!username || !pin) {
      setAuthError("Skriv inn brukernavn og PIN.");
      return;
    }

    const existing = findAccount(accounts, username);

    if (authMode === "signup") {
      if (existing) {
        setAuthError("Denne brukeren finnes allerede.");
        return;
      }

      const nextAccounts = [...accounts, { username, pin }];
      setAccounts(nextAccounts);
      saveUserData(username, createDefaultGameState());
      setCurrentUser(username);
      setAuthError("");
      setAuthName("");
      setAuthPin("");
      return;
    }

    if (!existing || existing.pin !== pin) {
      setAuthError("Feil brukernavn eller PIN.");
      return;
    }

    setCurrentUser(existing.username);
    setAuthError("");
    setAuthName("");
    setAuthPin("");
  };

  const logOut = () => {
    setCurrentUser("");
    setAuthMode("login");
    setAuthError("");
    setAuthPin("");
  };

  if (!currentUser) {
    return (
      <div className={`app-shell view-${viewMode}`}>
        <div className="app-topbar">
          <ViewModeToggle viewMode={viewMode} onChange={setViewMode} />
        </div>
        <div className="auth-shell">
          <section className="auth-card">
            <p className="eyebrow">Bondebridge</p>
            <h1>Logg inn</h1>
            <p className="lead">
              Kontoen lagrer spillere, pågående spill og autosave i denne nettleseren.
            </p>
            <div className="auth-tabs">
              <button
                type="button"
                className={authMode === "login" ? "active" : ""}
                onClick={() => {
                  setAuthMode("login");
                  setAuthError("");
                }}
              >
                Logg inn
              </button>
              <button
                type="button"
                className={authMode === "signup" ? "active" : ""}
                onClick={() => {
                  setAuthMode("signup");
                  setAuthError("");
                }}
              >
                Opprett konto
              </button>
            </div>
            <div className="auth-form">
              <label>
                Brukernavn
                <input
                  value={authName}
                  onChange={(event) => setAuthName(event.target.value)}
                  placeholder="F.eks. Markus"
                />
              </label>
              <label>
                PIN
                <input
                  type="password"
                  value={authPin}
                  onChange={(event) => setAuthPin(event.target.value)}
                  placeholder="4-6 tegn"
                />
              </label>
              {authError && <p className="auth-error">{authError}</p>}
              <button type="button" className="start-button" onClick={submitAuth}>
                {authMode === "signup" ? "Opprett konto" : "Logg inn"}
              </button>
            </div>
          </section>
        </div>
      </div>
    );
  }

  if (phase === "setup") {
    const maxCardsPossible = getMaxCardsPerPlayer(playerCount);

    return (
      <div className={`app-shell view-${viewMode}`}>
        <div className="app-topbar">
          <div className="app-topbar-actions">
            <span className="user-chip">{currentUser}</span>
            <button type="button" className="ghost small" onClick={logOut}>
              Logg ut
            </button>
            <ViewModeToggle viewMode={viewMode} onChange={setViewMode} />
          </div>
        </div>
        <div className="start-shell">
        <section className="start-card">
          <p className="eyebrow">Bondebridge</p>
          <h1>Nytt spill</h1>
          <p className="lead">
            Velg spillere med klikk, velg maks kort for rundeoppsett, og start når alt er klart.
          </p>

          <div className="setup-grid">
            <div className="top-controls">
              <div className="field-group compact top-control player-count-group">
                <label>Antall spillere</label>
                <div className="count-chips player-count-clean">
                {[3, 4, 5, 6].map((count) => (
                  <button
                    key={count}
                    type="button"
                      className={count === playerCount ? "active" : ""}
                      onClick={() => changePlayerCount(count)}
                    >
                      {count}
                    </button>
                  ))}
                </div>
              </div>

              <div className="field-group compact top-control">
                <label>Maks kort i oppsett</label>
                <div className="count-chips cards">
                  {Array.from({ length: maxCardsPossible }, (_, i) => i + 1).map((cards) => (
                    <button
                      key={cards}
                      type="button"
                      className={cards === peakCards ? "active" : ""}
                      onClick={() => setPeakCards(cards)}
                    >
                      {cards}
                    </button>
                  ))}
                </div>
                <p className="hint">Standard er høyest mulig: {maxCardsPossible}.</p>
              </div>

              <div className="field-group compact top-control">
                <label>Poengregel</label>
                <p className="top-note">0 stikk = 5 poeng</p>
                <p className="top-note">Ellers: 10 + stikk * stikk</p>
              </div>
            </div>

            <div className="field-group full">
              <label>Deltakere i dette spillet</label>
              <div className="player-slots">
                {players.map((player, index) => (
                  <div
                    className={`player-slot ${dragSeatId === player.seatId ? "dragging" : ""} ${
                      dragOverSeatId === player.seatId
                        ? dropPosition === "after"
                          ? "drop-after"
                          : "drop-before"
                        : ""
                    }`}
                    key={player.seatId}
                    draggable
                    onDragStart={(event) => onSeatDragStart(player.seatId, event)}
                    onDragOver={(event) => onSeatDragOver(player.seatId, event)}
                    onDrop={(event) => onSeatDrop(player.seatId, event)}
                    onDragEnd={onSeatDragEnd}
                  >
                    <div className="drag-handle" aria-hidden>
                      <span className="drag-dot" />
                      <span className="drag-dot" />
                      <span className="drag-dot" />
                      <span className="drag-dot" />
                      <span className="drag-dot" />
                      <span className="drag-dot" />
                    </div>
                    <label className="avatar-upload">
                      <div className={`avatar-wrap ${player.avatar ? "" : "empty"}`}>
                        {player.avatar ? (
                          <img src={player.avatar} alt={player.name || `Spiller ${index + 1}`} />
                        ) : (
                          <span className="avatar-empty-plus">+</span>
                        )}
                        <span className="avatar-upload-plus">+</span>
                      </div>
                      <input
                        type="file"
                        accept="image/*"
                        onChange={(event) =>
                          onUploadSeatAvatar(player.seatId, event.target.files?.[0])
                        }
                      />
                    </label>
                    <div className="slot-fields">
                      <input
                        value={player.name}
                        onChange={(event) =>
                          updatePlayerAtSeat(player.seatId, {
                            name: event.target.value,
                            savedPlayerId: null,
                          })
                        }
                        placeholder={`Spiller ${index + 1}`}
                      />
                      <div className="slot-actions">
                        {!isUnassignedSeat(player, index) && (
                          <button
                            type="button"
                            className="ghost small"
                            onClick={() => clearSeat(player.seatId)}
                          >
                            Fjern
                          </button>
                        )}
                        {shouldShowSaveButton(player, index, savedPlayers) && (
                          <button
                            type="button"
                            className="ghost small"
                            onClick={() => saveSeatAsLibraryPlayer(player)}
                          >
                            Lagre spiller
                          </button>
                        )}
                      </div>
                      {isUnassignedSeat(player, index) && availableSavedPlayers.length > 0 && (
                        <div className="slot-quick-pick">
                          <div className="quick-add-strip">
                            {availableSavedPlayers.map((saved) => (
                              <button
                                key={`${player.seatId}-${saved.id}`}
                                type="button"
                                className="quick-player"
                                onClick={() => applySavedPlayerToSeat(player.seatId, saved)}
                                title={`Legg til ${saved.name}`}
                              >
                                <span className="quick-avatar">
                                  {saved.avatar ? (
                                    <img src={saved.avatar} alt={saved.name} />
                                  ) : (
                                    <span>{saved.name[0]}</span>
                                  )}
                                </span>
                                <span className="quick-plus">+</span>
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="field-group full">
              <label>Spillerbank</label>
              <div className="library-create">
                <input
                  value={newPlayerName}
                  onChange={(event) => setNewPlayerName(event.target.value)}
                  placeholder="Navn på ny spiller"
                />
                <label className="file-btn">
                  Velg bilde
                  <input
                    type="file"
                    accept="image/*"
                    onChange={(event) => onUploadNewAvatar(event.target.files?.[0])}
                  />
                </label>
                <button type="button" onClick={addPlayerToLibrary}>
                  Legg til spiller
                </button>
              </div>

              <div className="library-grid">
                {savedPlayers.length === 0 && <p className="hint">Ingen lagrede spillere enda.</p>}
                {savedPlayers.map((saved) => (
                  <article className="library-card" key={saved.id}>
                    <div className="avatar-wrap small">
                      {saved.avatar ? <img src={saved.avatar} alt={saved.name} /> : <span>{saved.name[0]}</span>}
                    </div>
                    <div>
                      <strong>{saved.name}</strong>
                    </div>
                    <button
                      type="button"
                      className="ghost small danger"
                      onClick={() => removeSavedPlayer(saved.id)}
                    >
                      Slett
                    </button>
                  </article>
                ))}
              </div>
            </div>

          </div>

          <div className={`status ${setupValidation.valid ? "ok" : "warn"}`}>{setupValidation.message}</div>

          <button className="start-button" type="button" onClick={startGame} disabled={!setupValidation.valid}>
            Start spill
          </button>
        </section>
        </div>
      </div>
    );
  }

  return (
    <div className={`app-shell view-${viewMode}`}>
      <div className="app-topbar">
        <div className="app-topbar-actions">
          <span className="user-chip">{currentUser}</span>
          <button type="button" className="ghost small" onClick={logOut}>
            Logg ut
          </button>
          <ViewModeToggle viewMode={viewMode} onChange={setViewMode} />
        </div>
      </div>
      <div className="game-shell">
      <header className="game-header">
        <div>
          <p className="eyebrow">Bondebridge</p>
          <h2>In-game</h2>
          <p className="meta">
            Runde {currentRound?.number ?? 0} av {rounds.length} | Kort denne runden: {currentRound?.cards ?? 0}
          </p>
        </div>
        <button className="ghost" type="button" onClick={backToSetup}>
          Tilbake til oppsett
        </button>
      </header>

      <main className="game-layout">
        <section className="panel">
          <div className="round-nav">
            <button
              type="button"
              onClick={() => setRoundIndex((prev) => clamp(prev - 1, 0, rounds.length - 1))}
            >
              Forrige runde
            </button>
            <button
              type="button"
              onClick={() => setRoundIndex((prev) => clamp(prev + 1, 0, rounds.length - 1))}
            >
              Neste runde
            </button>
          </div>

          <div className="melding-signal">
            <div className={`signal-badge ${overUnder.tone}`}>{overUnder.signed}</div>
            <div className="signal-copy">
              <p>{overUnder.label}</p>
              <p>
                Meldinger sum: <strong>{totalBids}</strong> | Kort i runden: <strong>{currentRound?.cards ?? 0}</strong>
              </p>
            </div>
          </div>

          <div className="table">
            <div className="row header">
              <span>Spiller</span>
              <span>Melding</span>
              <span>Status</span>
              <span>Warnings</span>
              <span>Poeng</span>
              <span>Total</span>
            </div>
            {players.map((player) => {
              const bidValue = currentRound?.bids[player.seatId] ?? "";
              const stoodValue = currentRound?.stood[player.seatId] ?? true;
              const warningValue = Number(currentRound?.warnings[player.seatId] ?? 0);
              const roundPoints = pointsForRound(bidValue, stoodValue);

              return (
                <div className="row" key={player.seatId}>
                  <div className="row-section player-section">
                    <span className="player-cell">
                      <span className="avatar-wrap tiny">
                        {player.avatar ? (
                          <img src={player.avatar} alt={player.name} />
                        ) : (
                          <span>{player.name[0]}</span>
                        )}
                      </span>
                      {player.name}
                    </span>
                  </div>
                  <div className="row-section bid-section">
                    <span className="section-label">Melding</span>
                    <div className="count-chips bid-picker">
                      {Array.from(
                        { length: (currentRound?.cards ?? peakCards) + 1 },
                        (_, i) => i
                      ).map((bid) => (
                        <button
                          key={`${player.seatId}-${bid}`}
                          type="button"
                          className={Number(bidValue) === bid && bidValue !== "" ? "active" : ""}
                          onClick={() => updateRoundField(player.seatId, "bids", String(bid))}
                        >
                          {bid}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="row-section status-section">
                    <span className="section-label">Status</span>
                    <label className="toggle">
                      <button
                        type="button"
                        className={`state-button stand ${stoodValue ? "active" : ""}`}
                        onClick={() => updateRoundField(player.seatId, "stood", true)}
                      >
                        Stå
                      </button>
                      <button
                        type="button"
                        className={`state-button strike ${!stoodValue ? "active" : ""}`}
                        onClick={() => updateRoundField(player.seatId, "stood", false)}
                      >
                        Stryk
                      </button>
                    </label>
                  </div>
                  <div className="row-section warning-section">
                    <span className="section-label">Warnings</span>
                    <div className="warning-controls">
                      <button
                        type="button"
                        className="warning-button subtle"
                        onClick={() =>
                          updateRoundField(
                            player.seatId,
                            "warnings",
                            Math.max(0, warningValue - 1)
                          )
                        }
                      >
                        W-
                      </button>
                      <span className="warning-value">{warningValue}</span>
                      <button
                        type="button"
                        className="warning-button danger"
                        onClick={() =>
                          updateRoundField(player.seatId, "warnings", warningValue + 1)
                        }
                      >
                        W+
                      </button>
                    </div>
                  </div>
                  <div className="row-section points-section">
                    <span className="section-label">Poeng</span>
                    <span className="mono">{roundPoints}</span>
                  </div>
                  <div className="row-section total-section">
                    <span className="section-label">Total</span>
                    <span className="mono">{playerStats[player.seatId].total}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <section className="panel score-panel">
          <h3>Totalscore</h3>
          <div className="scoreboard">
            {players.map((player) => (
              <div className="score-card" key={player.seatId}>
                <div className="score-card-copy">
                  <span className="score-player-name">
                    {player.name}
                    {playerStats[player.seatId].currentMissedInRow === 2 && (
                      <span className="streak-warning-light" title="To stryk på rad">
                        🚦
                      </span>
                    )}
                  </span>
                  <small>
                    Warnings {playerStats[player.seatId].warnings} ({playerStats[player.seatId].warningPenalty})
                  </small>
                  <small>
                    Stryk-straff {playerStats[player.seatId].streakPenalty}
                  </small>
                </div>
                <strong
                  className={`score-total ${
                    playerStats[player.seatId].currentMissedInRow >= 6
                      ? "penalty-six"
                      : playerStats[player.seatId].currentMissedInRow >= 3
                        ? "penalty-three"
                        : ""
                  }`}
                >
                  {playerStats[player.seatId].total}
                </strong>
              </div>
            ))}
          </div>
          <div className="round-summary">
            <div className="round-summary-header">
              <h4>Siste 5 runder</h4>
              <button
                type="button"
                className="ghost small"
                onClick={() => setShowAllRounds((previous) => !previous)}
              >
                {showAllRounds ? "Skjul alle" : "Vis alle"}
              </button>
            </div>
            <div className="round-score-table">
              <div className="round-score-row header">
                <span>Runde</span>
                {players.map((player) => (
                  <span key={`recent-header-${player.seatId}`}>{player.name}</span>
                ))}
              </div>
              {recentRoundRows.map((row) => (
                <div className="round-score-row" key={`recent-${row.id}`}>
                  <span>R{row.number}</span>
                  {players.map((player) => (
                    <span
                      key={`recent-${row.id}-${player.seatId}`}
                      className={`round-score-value ${
                        row.values[player.seatId]?.streakTriggerLevel === 6
                          ? "penalty-six"
                          : row.values[player.seatId]?.streakTriggerLevel === 3
                            ? "penalty-three"
                            : ""
                      }`}
                    >
                      {row.values[player.seatId]?.totalDelta ?? 0}
                    </span>
                  ))}
                </div>
              ))}
            </div>
            {showAllRounds && (
              <div className="round-summary-all">
                <div className="round-score-table full">
                  <div className="round-score-row header">
                    <span>Runde</span>
                    <span>Kort</span>
                    {players.map((player) => (
                      <span key={`all-header-${player.seatId}`}>{player.name}</span>
                    ))}
                  </div>
                  {roundScoreRows.map((row) => (
                    <div className="round-score-row" key={`all-${row.id}`}>
                      <span>R{row.number}</span>
                      <span>{row.cards}</span>
                      {players.map((player) => (
                        <span
                          key={`all-${row.id}-${player.seatId}`}
                          className={`round-score-value ${
                            row.values[player.seatId]?.streakTriggerLevel === 6
                              ? "penalty-six"
                              : row.values[player.seatId]?.streakTriggerLevel === 3
                                ? "penalty-three"
                                : ""
                          }`}
                        >
                          {row.values[player.seatId]?.totalDelta ?? 0}
                        </span>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </section>
      </main>
      </div>
    </div>
  );
}
