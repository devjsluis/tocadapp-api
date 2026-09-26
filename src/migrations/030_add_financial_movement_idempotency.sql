ALTER TABLE financial_movements
ADD COLUMN IF NOT EXISTS client_operation_id VARCHAR(100);

CREATE UNIQUE INDEX IF NOT EXISTS financial_movements_user_client_operation_id_unique
ON financial_movements (user_id, client_operation_id)
WHERE client_operation_id IS NOT NULL;
