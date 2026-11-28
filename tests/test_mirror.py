import sqlite3
import sys
import unittest
from decimal import Decimal
from pathlib import Path
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from mirror import Mirror


class MirrorTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.addCleanup(self.db.close)
        self.exchange = Mock()
        self.exchange.info.meta.return_value = {'universe': [{'name': 'ETH', 'szDecimals': 2}]}
        self.exchange.info.all_mids.return_value = {'ETH': '100'}
        self.exchange.info.user_state.return_value = {
            'assetPositions': [], 'marginSummary': {'accountValue': '10000'}}
        self.restart()

    def restart(self):
        self.mirror = Mirror(self.exchange, 'follower', Decimal('.1'), Decimal('.05'), self.db)

    def send(self, tid, side, before, size, user='leader', elapsed=1):
        self.mirror.fill(user, {'coin': 'ETH', 'tid': tid, 'time': self.mirror.started + elapsed,
                               'px': '100', 'side': side, 'startPosition': str(before), 'sz': str(size)})

    @staticmethod
    def filled(size):
        return {'response': {'data': {'statuses': [{'filled': {'totalSz': size}}]}}}

    def test_partial_entry_and_proportional_exit_after_restart(self):
        self.exchange.market_open.return_value = self.filled('1.5')
        self.send(1, 'B', 0, 20, elapsed=-1)
        self.exchange.market_open.assert_not_called()
        self.send(2, 'B', 0, 20)
        self.restart()
        self.send(2, 'B', 0, 20)
        self.exchange.market_open.assert_called_once()
        self.exchange.info.user_state.return_value['assetPositions'] = [
            {'position': {'coin': 'ETH', 'szi': '1.5'}}]
        self.send(3, 'A', 20, 10, user='another-leader')
        self.exchange.order.assert_not_called()
        self.exchange.order.return_value = self.filled('0.75')
        self.send(4, 'A', 20, 10)
        args, kwargs = self.exchange.order.call_args
        self.assertEqual(args[:3], ('ETH', False, 0.75))
        self.assertTrue(kwargs['reduce_only'])

    def test_cap_skip_cannot_become_a_late_open_on_reconnect(self):
        state = self.exchange.info.user_state.return_value
        state['marginSummary']['accountValue'] = '100'
        self.send(10, 'B', 0, 20)
        state['marginSummary']['accountValue'] = '10000'
        self.send(10, 'B', 0, 20)
        self.exchange.market_open.assert_not_called()

    def test_entry_limit_remains_anchored_to_leader_after_adverse_move(self):
        self.exchange.market_open.return_value = self.filled('1')
        for side, mid, tid in [('B', '114', 10), ('A', '88', 11)]:
            self.exchange.info.all_mids.return_value = {'ETH': mid}
            self.send(tid, side, 0, 10)
            self.assertEqual(self.exchange.market_open.call_args.args[3], 100)

    def test_unconfirmed_submission_blocks_replays_and_new_orders_on_coin(self):
        self.exchange.market_open.side_effect = TimeoutError()
        with self.assertRaises(TimeoutError):
            self.send(1, 'B', 0, 20)
        self.restart()
        self.send(1, 'B', 0, 20)
        self.send(2, 'B', 20, 20)
        self.exchange.market_open.assert_called_once()


if __name__ == '__main__':
    unittest.main()
