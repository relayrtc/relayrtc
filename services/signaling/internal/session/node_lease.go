package session

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type NodeLease struct {
	connection *pgx.Conn
	InstanceID string
}

func AcquireNodeLease(ctx context.Context, databaseURL, nodeID string) (*NodeLease, error) {
	connection, err := pgx.Connect(ctx, databaseURL)
	if err != nil {
		return nil, err
	}
	acquired := false
	defer func() {
		if !acquired {
			cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_ = connection.Close(cleanup)
		}
	}()
	var locked bool
	if err := connection.QueryRow(ctx, `SELECT pg_try_advisory_lock(732, 450)`).Scan(&locked); err != nil {
		return nil, err
	}
	if !locked {
		return nil, errors.New("only one signaling owner per database is supported; another owner is running")
	}
	var token [16]byte
	if _, err := rand.Read(token[:]); err != nil {
		return nil, err
	}
	instanceID := hex.EncodeToString(token[:])
	tx, err := connection.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `INSERT INTO signaling_node_lease (id, node_id, instance_id, heartbeat_at, expires_at)
 VALUES ('owner', $1, $2, now(), now() + interval '20 seconds')
 ON CONFLICT (id) DO UPDATE SET node_id = EXCLUDED.node_id, instance_id = EXCLUDED.instance_id,
 heartbeat_at = EXCLUDED.heartbeat_at, expires_at = EXCLUDED.expires_at`, nodeID, instanceID); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `SELECT reconcile_signaling_sessions($1)`, instanceID); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	acquired = true
	return &NodeLease{connection: connection, InstanceID: instanceID}, nil
}

func (lease *NodeLease) KeepAlive(ctx context.Context, cancelOwner context.CancelFunc) <-chan error {
	done := make(chan error, 1)
	go func() {
		defer close(done)
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				operation, cancel := context.WithTimeout(ctx, 5*time.Second)
				var result pgconn.CommandTag
				var err error
				for attempt := 0; attempt < 3; attempt++ {
					result, err = lease.connection.Exec(operation, `UPDATE signaling_node_lease SET heartbeat_at = now(), expires_at = now() + interval '20 seconds'
 WHERE id = 'owner' AND instance_id = $1 AND expires_at > now()`, lease.InstanceID)
					var failure *pgconn.PgError
					if !errors.As(err, &failure) || (failure.Code != "40P01" && failure.Code != "40001") {
						break
					}
					select {
					case <-operation.Done():
					case <-time.After(100 * time.Millisecond):
					}
				}
				cancel()
				if err != nil || result.RowsAffected() != 1 {
					cancelOwner()
					done <- fmt.Errorf("signaling owner lease lost: %w", errors.Join(err, errors.New("owner must stop accepting connections")))
					return
				}
			}
		}
	}()
	return done
}

func (lease *NodeLease) Close() {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, _ = lease.connection.Exec(ctx, `UPDATE signaling_node_lease SET expires_at = now() WHERE id = 'owner' AND instance_id = $1`, lease.InstanceID)
	_ = lease.connection.Close(ctx)
}
