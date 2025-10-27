import { useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import { fr } from 'date-fns/locale';
import { supabase } from './lib/supabaseClient.js';
import './App.css';

const GAME_CODE = 'BELGFR';
const DEFAULT_PLAYERS = [
  { name: 'Eliott', initial_score: 4 },
  { name: 'Timéo', initial_score: 4 },
  { name: 'Lilouan', initial_score: 4 },
];

function computeScores(players, history) {
  const scoreMap = new Map(players.map((player) => [player.id, player.initial_score]));
  history.forEach((entry) => {
    scoreMap.set(entry.player_id, (scoreMap.get(entry.player_id) ?? 0) + entry.delta);
  });
  return scoreMap;
}

export default function App() {
  const [game, setGame] = useState(null);
  const [players, setPlayers] = useState([]);
  const [history, setHistory] = useState([]);
  const [comments, setComments] = useState({});
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [undoLoading, setUndoLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let active = true;
    let subscription;

    async function ensureGame() {
      setLoading(true);
      setError(null);

      try {
        const { data: existingGame, error: gameError } = await supabase
          .from('games')
          .select('*')
          .eq('code', GAME_CODE)
          .maybeSingle();

        if (gameError) {
          throw gameError;
        }

        let gameRecord = existingGame;

        if (!gameRecord) {
          const { data: createdGame, error: createGameError } = await supabase
            .from('games')
            .insert({ name: 'Belgique vs France', code: GAME_CODE })
            .select()
            .single();

          if (createGameError) {
            throw createGameError;
          }

          gameRecord = createdGame;
        }

        if (!active) return;
        setGame(gameRecord);

        const { data: existingPlayers, error: playersError } = await supabase
          .from('players')
          .select('*')
          .eq('game_id', gameRecord.id)
          .order('created_at', { ascending: true });

        if (playersError) {
          throw playersError;
        }

        if (existingPlayers.length === 0) {
          const { error: insertPlayersError } = await supabase.from('players').insert(
            DEFAULT_PLAYERS.map((player) => ({
              ...player,
              game_id: gameRecord.id,
            })),
          );

          if (insertPlayersError) {
            throw insertPlayersError;
          }

          const { data: freshPlayers, error: freshPlayersError } = await supabase
            .from('players')
            .select('*')
            .eq('game_id', gameRecord.id)
            .order('created_at', { ascending: true });

          if (freshPlayersError) {
            throw freshPlayersError;
          }

          if (!active) return;
          setPlayers(freshPlayers);
          setComments(freshPlayers.reduce((acc, player) => ({ ...acc, [player.id]: '' }), {}));
        } else {
          if (!active) return;
          setPlayers(existingPlayers);
          setComments(existingPlayers.reduce((acc, player) => ({ ...acc, [player.id]: '' }), {}));
        }

        const { data: points, error: pointsError } = await supabase
          .from('points')
          .select('*')
          .eq('game_id', gameRecord.id)
          .order('created_at', { ascending: true });

        if (pointsError) {
          throw pointsError;
        }

        if (!active) return;
        setHistory(points);

        subscription = supabase
          .channel(`public:points:game:${gameRecord.id}`)
          .on(
            'postgres_changes',
            {
              event: '*',
              schema: 'public',
              table: 'points',
              filter: `game_id=eq.${gameRecord.id}`,
            },
            (payload) => {
              if (!active) return;
              setHistory((prev) => {
                if (payload.eventType === 'INSERT') {
                  return [...prev, payload.new];
                }

                if (payload.eventType === 'DELETE') {
                  return prev.filter((entry) => entry.id !== payload.old.id);
                }

                if (payload.eventType === 'UPDATE') {
                  return prev.map((entry) =>
                    entry.id === payload.new.id ? { ...entry, ...payload.new } : entry,
                  );
                }

                return prev;
              });
            },
          )
          .subscribe();
      } catch (err) {
        console.error(err);
        if (active) {
          setError("Impossible de charger les données. Vérifie ta connexion internet.");
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    ensureGame();

    return () => {
      active = false;
      if (subscription) {
        supabase.removeChannel(subscription);
      }
    };
  }, []);

  const scores = useMemo(() => computeScores(players, history), [players, history]);

  async function handleDelta(playerId, delta) {
    if (!game) return;
    setActionLoading(true);
    setError(null);

    try {
      const comment = comments[playerId]?.trim() || null;

      const { error: insertError } = await supabase.from('points').insert({
        game_id: game.id,
        player_id: playerId,
        delta,
        comment,
      });

      if (insertError) {
        throw insertError;
      }

      setComments((prev) => ({ ...prev, [playerId]: '' }));
    } catch (err) {
      console.error(err);
      setError("Impossible d'enregistrer le point. Réessaie dans un instant.");
    } finally {
      setActionLoading(false);
    }
  }

  async function handleUndo() {
    if (!game) return;
    setUndoLoading(true);
    setError(null);

    try {
      const { data: lastPoint, error: lastError } = await supabase
        .from('points')
        .select('*')
        .eq('game_id', game.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (lastError) {
        throw lastError;
      }

      if (!lastPoint) {
        setError("Aucun point à annuler.");
        return;
      }

      const { error: deleteError } = await supabase
        .from('points')
        .delete()
        .eq('id', lastPoint.id);

      if (deleteError) {
        throw deleteError;
      }
    } catch (err) {
      console.error(err);
      setError("Annulation impossible pour le moment.");
    } finally {
      setUndoLoading(false);
    }
  }

  const playerById = useMemo(() => {
    const map = new Map();
    players.forEach((player) => {
      map.set(player.id, player);
    });
    return map;
  }, [players]);

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>Belgique vs France</h1>
        <p>Scoreboard collaboratif pour suivre les différences entre Eliott, Timéo et Lilouan.</p>
      </header>

      {error && <div className="alert alert-error">{error}</div>}

      {loading ? (
        <div className="loading">Chargement en cours…</div>
      ) : (
        <>
          <section className="scoreboard">
            {players.map((player) => (
              <article key={player.id} className="player-card">
                <h2>{player.name}</h2>
                <p className="player-score">{scores.get(player.id) ?? player.initial_score}</p>
                <p className="initial-score">Score de départ : {player.initial_score}</p>
                <label className="comment-label" htmlFor={`comment-${player.id}`}>
                  Commentaire (facultatif)
                </label>
                <input
                  id={`comment-${player.id}`}
                  className="comment-input"
                  type="text"
                  value={comments[player.id] ?? ''}
                  placeholder="Ex. super réponse !"
                  onChange={(event) =>
                    setComments((prev) => ({ ...prev, [player.id]: event.target.value }))
                  }
                />
                <div className="actions">
                  <button
                    type="button"
                    onClick={() => handleDelta(player.id, 1)}
                    disabled={actionLoading}
                    className="btn primary"
                  >
                    +1
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelta(player.id, -1)}
                    disabled={actionLoading}
                    className="btn ghost"
                  >
                    -1
                  </button>
                </div>
              </article>
            ))}
          </section>

          <section className="history">
            <div className="history-header">
              <h2>Historique des points</h2>
              <button
                type="button"
                className="btn link"
                onClick={handleUndo}
                disabled={undoLoading}
              >
                {undoLoading ? 'Annulation…' : 'Annuler le dernier point'}
              </button>
            </div>
            {history.length === 0 ? (
              <p className="history-empty">Aucun point enregistré pour le moment.</p>
            ) : (
              <ul className="history-list">
                {[...history]
                  .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
                  .map((entry) => {
                    const player = playerById.get(entry.player_id);
                    const createdAt = entry.created_at
                      ? format(new Date(entry.created_at), 'dd/MM/yyyy HH:mm', { locale: fr })
                      : '';
                    return (
                      <li key={entry.id} className="history-item">
                        <div className={`delta ${entry.delta > 0 ? 'positive' : 'negative'}`}>
                          {entry.delta > 0 ? `+${entry.delta}` : entry.delta}
                        </div>
                        <div className="history-content">
                          <p className="history-player">{player?.name ?? 'Inconnu'}</p>
                          {entry.comment && <p className="history-comment">“{entry.comment}”</p>}
                          <p className="history-date">{createdAt}</p>
                        </div>
                      </li>
                    );
                  })}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
