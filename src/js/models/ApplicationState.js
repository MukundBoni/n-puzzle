/**
 * This model represents the overall application state, and implements the
 * most of the runtime logic for the application. The current configuration
 * and active search tree are maintained as child models (or sub-models).
 *
 * Notably, the start() method encapsulates the logic relating to 'Actions',
 * which are objects that modify the search tree or application state in 
 * some way. Actions are used any time that a user should be permitted to
 * reverse a change. The next() and undo() methods also provide some of
 * this functionality.
 */
ApplicationState = Backbone.Model.extend({
	
	initialize: function() {
		
		this.treeUndoActions = [];
		this.treeRedoActions = [];

		// Set defaults
		this.set({
			'algorithm': null,
			'state': 'stopped'
		});
		
		if (this.has('configuration')) {
			this.get('configuration').on('change', 
				this.onChangeConfiguration, 
				this);
		} else {
			throw "A default configuration has not been provided to the ApplicationState model.";
		}
		
		if (this.has('searchTree')) {
			this.get('searchTree').on('change',
				this.onChangeTree, 
				this);
		} else {
			throw "A search tree has not been provided to the ApplicationState model.";
		}
		
		this.set('statistics', []);
	},
	
	/** 
	 *  Schedules the next() method to be called in 300 ms.
	 */	
	doBurst: function() {
		setTimeout(_.bind(function() {
			this.next();
		}, this), 20);
	},
	
	getConfiguration: function() {
		return this.get('configuration');
	},
	
	getNumberOfUndoActions: function() {
		return this.treeUndoActions.length;
	},

	getState: function() {
		return this.get('state');
	},
	
	getStatistics: function() {
		return this.get('statistics');
	},
	
	getTree: function() {
		return this.get('searchTree');
	},
	
	isComplete: function() {
		return this.get('state') == 'complete';
	},
	
	isPaused: function() {
		return this.get('state') == 'paused';
	},
	
	isRunning: function() {
		return this.get('state') == 'running';
	},
	
	isStopped: function() {
		return this.get('state') == 'stopped';
	},
	
	onChangeConfiguration: function() {
		this.trigger('change:configuration');
	},
	
	onChangeTree: function() {
		this.trigger('change:tree');
	},
	
	undo: function() {
		if (this.treeUndoActions.length > 0) {
			var action = this.treeUndoActions.pop();
			var redoAction = action.execute();
			this.treeRedoActions.push(redoAction);
			this.trigger('change');
		}
	},

	/**
	 * Begins the next iteration of the active algorithm.
	 * 
	 * If the application is in burst mode, then this method will call doBurst()
	 * to schedule the next iteration.
	 */
	next: function() {

		var algorithm = this.get('algorithm');
		if (this.isRunning()) {

			if (this.treeRedoActions.length > 0) {
				
				var action = this.treeRedoActions.pop();
				var undoAction = action.execute();
				this.treeUndoActions.push(undoAction);
				this.trigger('change');

			} else 	if (algorithm.iterate()) {
		
				var stats = algorithm.getStatistics();
				this.set('statistics', stats);

			} else {

				this.set('statistics', algorithm.getStatistics());
				if (this.getConfiguration().getMode() == 'burst' &&
					this.isRunning()) {
					this.doBurst();
				}
			}
		}
		
		return this;
	},
	
	/**
	 * Switches the application into the paused state.
	 * 
	 * This only applies while in burst mode.
	 */
	pause: function() {
		if (this.isRunning() && this.getConfiguration().getMode() == 'burst') {
			this.set({
				'state': 'paused'
			});
		}
		
		return this;
	},
	
	/**
	 * Resets the current algorithm and destroys the current search tree.
	 */
	reset: function() {
		if (this.isRunning() || this.isPaused() || this.isComplete()) {
			this.treeUndoActions = [];
			this.treeRedoActions = [];
			this.get('searchTree').setRootNode(null);
			this.set({
				'algorithm': null,
				'state': 'stopped',
				'statistics': []
			});
			this.trigger('reset:tree');
			this.getConfiguration().getInitialState().setHeuristicValue(null);
		}
		
		return this;
	},
	
	/**
	 * Resumes iterating the algorithm if the application has been paused. 
	 * 
	 * This only applies while in burst mode.
	 */	
	resume: function() {
		if (this.isPaused() && this.getConfiguration().getMode() == 'burst') {
			this.set('state', 'running');
			this.next();
		}
		
		return this;
	},
	
	/**
	 * Prepares a new algorithm using the current configuration.
	 *
	 * Regretably, a lot of the application logic is encapsulated in this one
	 * method. In order to support undo/redo behaviour, any change to the tree
	 * is performed by an Action object (e.g. UpdateStateKindAction to update
	 * the 'kind' attribute for a state). 
	 *
	 * Action objects have one method called 'execute' which, when called, 
	 * performs the action and returns another Action object that will undo 
	 * the change. Actions are designed such that they do not rely on 
	 * references. Instead, they use string and integer identifiers that will
	 * not change between invocations of an action.
	 *
	 */
	start: function() {
		
		// Locate the algorithm constructor function
		var config = this.getConfiguration();
		var availableConfigs = config.getAvailableConfigurations();
		var algorithms = availableConfigs.getAvailableAlgorithms();
		var selectedAlgorithm = config.getAlgorithm();
		var AlgorithmConstructor = window[algorithms[selectedAlgorithm].className];

		// Find the name of the heuristic function
		var heuristicName = null;
		if (algorithms[selectedAlgorithm].usesHeuristic) {
			var heuristics = availableConfigs.getAvailableHeuristics();
			heuristicName = heuristics[config.getHeuristic()].fnName; 
		}

		// Map of states to nodes. This allows each state to be matched to its
		// node within the tree. Nodes are indexed using the 'long identifier'
		// that can be generated from a PuzzleState. A long identifier
		// uniquely identifies a state within the entire state space by
		// concatenating the short identifiers of all states from the initial
		// state to the spcified state.
		var statesMappedToNodes = {};
		
		// Alias initial and goal states
		var initialState = config.getInitialState();
		var goalState = config.getGoalState();

		/**
		 * Constructor function that will initialise an Action that will add
		 * an array of states to the tree. The states in the augmentedStates
		 * array are expected to be siblings (i.e. children of the same parent
		 * state).
		 *
		 * A new node will be created for each state in the augmentedStates
		 * array. If the specified tree does not have a root node, and only
		 * one node is being added to the tree, then that node will become the
		 * new root node. In this case, the execute() method will return null
		 * as it should not be possible to 'un-add' the root node of the tree.
		 *
		 * If the tree already has a root node, then the new child nodes will
		 * be added to the tree, and execute() will return a new action that
		 * can be used to remove the nodes from the tree.
		 *
		 * @param  augmentedStates  an array of states to be added to the tree
		 * @param  parentState  shared parent state of augmentedStates
		 * @param  tree  the tree that the nodes should be added to
		 */
		var AddStatesToTreeAction = function(augmentedStates, parentState, tree) {

			this.execute = function() {

				// Find parent node
				var parentNode = null;
				if (parentState != null) {
					var parentId = parentState.getLongIdentifier();
					parentNode = statesMappedToNodes[parentId];
				}

				var newNodes = [];
				var newStates = [];
				for (var i = 0; i < augmentedStates.length; i++) {

					// Aliases
					var augmentedState = augmentedStates[i];
					var state = augmentedState.originalState;

					// Make a new node
					var newNode = new SearchTreeNode(parentNode, state, {
						kind: augmentedState.kind
					});

					newNode.augmentedState = augmentedState;

					// Add node to the state->node map
					var stateId = state.getLongIdentifier();
					statesMappedToNodes[stateId] = newNode;

					newNodes.push(newNode);
					newStates.push(state);
				}

				// If the root node of the tree is not set, and only one node
				// has been added to the tree, then it must be the root node.
				if (tree.getRootNode() == null) {
					if (augmentedStates.length == 1) {
						tree.setRootNode(newNodes[0]);
						// This change cannot be undone.
						return null;
					} else {
						// If more than one node is added to a tree with no
						// root node, then we should throw an exception, since
						// this will break the program.
						throw "Cannot add more than one root node to the tree";
					}
				}

				// Setting the root node of the tree like this will cause the
				// tree to be redrawn.
				tree.setRootNode(tree.getRootNode());

				// Return an action to undo the changes
				return new RemoveStatesFromTreeAction(newStates, parentState, tree);
			}

		};

		/**
		 * Constructor function that will initialise an action that reverts
		 * the changes made by AddStatesToTreeAction.
		 *
		 * This action takes an array of states that should be removed from the
		 * tree, removes them, then returns an action that can be used to add
		 * them to the tree again. The states should all be siblings.
		 *
		 * @param  states  states to be removed
		 * @param  parentState  shared parent state of the states array
		 * @param  tree  tree that is being altered
		 */
		var RemoveStatesFromTreeAction = function(states, parentState, tree) {
			this.execute = function() {

				if (parentState == null) {
					throw "Cannot remove nodes from tree without parent state";
				}
				
				// Find parent node
				var parentId = parentState.getLongIdentifier();
				var parentNode = statesMappedToNodes[parentId];
				
				// For each state that should be removed
				var augmentedStates = [];
				for (var i = 0; i < states.length; i++) {
					
					// Get the associated node
					var state = states[i];
					var stateId = state.getLongIdentifier();
					var node = statesMappedToNodes[stateId];

					// Clone the node's attributes to build an augmented state
					var attributes = node.getAttributes();
					var augmentedState = _.clone(node.getAttributes());
					augmentedState.originalState = state;

					// Add that to the list of states that would need to be
					// recreated if this action was undone.
					augmentedStates.push(augmentedState);

					// And finally, remove the node from the parent, and delete
					// it from the state->node map
					parentNode.removeChild(node);
					delete statesMappedToNodes[stateId];
				}

				// Setting the root node of the tree like this will cause the
				// tree to be redrawn.
				tree.setRootNode(tree.getRootNode());

				return new AddStatesToTreeAction(
					augmentedStates, parentState, tree
				);
			}
		};

		/**
		 * Constructor function that will initialise an action that 
		 * replaces the root node of a tree, as well as the state->node map.
		 *
		 * This is used to allow the Iterative-Deepening Search algorithm to
		 * clear the tree whenever the maximum depth value is changed.
		 *
		 * The execute() method will return another ReplaceRootNodeAction
		 * object that be used to revert the changes.
		 *
		 * @param  newRoot  new root node
		 * @param  newMap   state->node map corresponding to the new root
		 *                  node and its descendants
		 * @param  tree     the tree that is being altered
		 */
		var ReplaceRootNodeAction = function(newRoot, newMap, tree) {
			this.execute = function() {
				var oldMap = _.clone(statesMappedToNodes);
				statesMappedToNodes = newMap;
				var oldRoot = tree.getRootNode();
				tree.setRootNode(newRoot);
				return new ReplaceRootNodeAction(oldRoot, oldMap, tree);
			}
		};

		/**
		 * Constructor function that will initialise an action that
		 * updates the current state of an ApplicationState instance.
		 * 
		 * The execute() method will return another instance of
		 * UpdateApplicationStateAction that can be used to revert the change.
		 *
		 * @param  model  the ApplicationState instance to be updated
		 * @param  state  the new state value
		 */
		var UpdateApplicationStateAction = function(model, state) {
			this.execute = function() {
				var oldState = model.get('state');
				model.set('state', state);
				return new UpdateApplicationStateAction(model, oldState);
			}
		};

		/**
		 * Constructor function that will initialise an action that
		 * updates the local copy of the algorithm statistics held by an 
		 * ApplicationState instance.
		 *
		 * The execute() method will return another instance of
		 * UpdateAlgorithmStatsAction that can be used to revert the change.
		 *
		 * @param  model  the ApplicationState instance to be updated
		 * @param  stats  the new stats object
		 */
		var UpdateAlgorithmStatsAction = function(model, stats) {
			this.execute = function() {
				var oldStats = model.get('statistics');
				model.set('statistics', stats);
				return new UpdateAlgorithmStatsAction(model, oldStats);
			}
		};

		/**
		 * Constructor function that will initialise an action that updates
		 * the specified attribute of a node in the search tree (identified
		 * by its associated state).
		 *
		 * The execute() method will return another instance of
		 * UpdateStateAttributeAction that can be used to revert the change.
		 *
		 * @param  state  state that identifies the node to be updated
		 * @param  attribute  name of the attribute to be updated
		 * @param  value  new value of the attribute
		 */
		var UpdateStateAttributeAction = function(state, attribute, value) {
			this.execute = function() {
				var stateId = state.getLongIdentifier();
				if (!statesMappedToNodes.hasOwnProperty(stateId)) {
					throw("Could not update kind of unknown state: " + stateId);
				}
				var node = statesMappedToNodes[stateId];
				var attributes = node.getAttributes();
				var oldValue = attributes[attribute];
				attributes[attribute] = value;
				
				return new UpdateStateAttributeAction(
					state, attribute, oldValue);
			}
		}

		/**
		 * Constructor function that initialise an action that performs a
		 * number of other actions, in sequence.
		 *
		 * The execute() method will return another instance of CompositeAction
		 * that will revert the all of the actions performed (if possible).
		 *
		 * @param  actions  an array of Action objects
		 */
		var CompositeAction = function(actions) {
			this.execute = function() {
				var undoActions = [];
				for (var i = 0; i < actions.length; i++) {
					var undoAction = actions[i].execute();
					if (undoAction != null) {
						undoActions.push(undoAction);
					}
				}
				return new CompositeAction(undoActions);
			}
		};

		/**
		 * Algorithm callback method that handles the discovery of an array of
		 * successor states for a particular parent state.
		 * 
		 * @param  augmentedStates  an array of successor states
		 * @param  parentState      the parentState of all states in the
		 *                          augmentedStates array.
		 */
		var onDiscover = _.bind(function(augmentedStates, parentState) {
			
			// Get the current root node
			var searchTree = this.get('searchTree');
			var alg = this.get('algorithm');

			// List of actions that have been performed so far
			var localActions = [];

			// List of states that should be added to the tree, populated
			// below...
			var newAugmentedStates = [];

			// Process each state. If the state has been added to the tree
			// previously, then execute an UpdateStateAttributeAction.
			// Otherwise, add the state to the list of states that should
			// be added to the tree
			for (var i = 0; i < augmentedStates.length; i++) {

				// Aliases
				var augmentedState = augmentedStates[i];
				var state = augmentedState.originalState;
				
				// Check for existing node
				var stateId = state.getLongIdentifier();
				if (statesMappedToNodes.hasOwnProperty(stateId)) {
					
					// If the state already has a node in the tree, then
					// update the relevant attributes
					var updateNodeKindAction = new UpdateStateAttributeAction(
						state, 'kind', augmentedState.kind);

					// Add the action to the list of actions performed so far
					localActions.push(updateNodeKindAction.execute());

					// Check next state.
					continue;
				}

				// If the state has not been seen before, then we'll need to
				// add it to the tree
				newAugmentedStates.push(augmentedState);
			}


			// Special case for IDS:
			// If the parentState is null, but there is at least one action in
			// the undo list, then the IDS algorithm must be restarting the
			// search at the root of the tree (after incrementing the maximum
			// depth). 
			var rootId = null;
			var rootNode = searchTree.getRootNode();
			if (rootNode != null) {
				rootId = rootNode.getState().getLongIdentifier();
			}

			if (augmentedStates.length == 1 && newAugmentedStates.length == 0 &&
				parentState == null && 
				rootId == augmentedStates[0].originalState.getLongIdentifier()) {

				// Aliases
				var augmentedState = augmentedStates[0];
				var state = augmentedState.originalState;

				// To handle this special case, we need to create a new root
				var newNode = new SearchTreeNode(null, state, {
					kind: augmentedState.kind
				});

				// We also need to reset the state->node map, so that when
				// states are re-discovered, they can be added to the tree.
				// Undoing the action will restore the previous root node, as
				// well as the previous state->node map.
				var newStatesMappedToNodes = {};
				newStatesMappedToNodes[state.getLongIdentifier()] = newNode;

				// Finally, we can perform the action
				var action = new ReplaceRootNodeAction(newNode, 
					newStatesMappedToNodes, 
					searchTree);
				localActions.push(action.execute());

			} else {

				// Create an action that will add the new states to the tree
				var addStateToTreeAction = new AddStatesToTreeAction(
					newAugmentedStates,
					parentState,
					searchTree
				);

				// Execute the AddStatesToTreeAction, and if the action is
				// reversible, add the undo action to the list of actions performed
				// so far.
				var undoAction = addStateToTreeAction.execute();
				if (undoAction != null) {
					localActions.push(undoAction);
				}
			}

			// Check for goal states. If there a goal state has been
			// discovered, then the Application state should be updated to 
			// 'complete'. Reversing this action (i.e. clicking 'Back') will
			// revert the application state to whatever it was prior to the
			// goal being found.
			for (var i = 0; i < augmentedStates.length; i++) {
				if (augmentedStates[i].kind == 'goal') {
					var action = new UpdateApplicationStateAction(this, 'complete');
					localActions.push(action.execute());
				}
			}

			// Make a copy of the algorithm stats, create an action to update
			// ApplicationState copy of those stats, and execute the action.
			if (alg != null) {
				var updateStatsAction = new UpdateAlgorithmStatsAction(this, 
					_.clone(alg.getStatistics()));
				localActions.push(updateStatsAction.execute());
			}

			if (localActions.length > 1) {
				// Create a composite action to perform all of the actions
				// required for this iteration.
				this.treeUndoActions.push(new CompositeAction(localActions));
			} else if (localActions.length == 1) {
				this.treeUndoActions.push(localActions.pop());
			}

			this.trigger('change');

			searchTree.setRootNode(searchTree.getRootNode());
			
		}, this);
		
		/**
		 * Algorithm callback method that checks whether a state is a goal state
		 * 
		 * @param  state  the state to be checked
		 * @return returns true if the state is a goal state, false otherwise
		 */
		var isGoalState = _.bind(function(state) {
			return state.isEqualTo(goalState);
		}, this)
		
		/**
		 * Algorithm callback method that calculates the selected heuristic
		 * measure for the goal state and the specified state.
		 */
		var heuristicFunction = _.bind(function(state) {
			if (heuristicName != null) {
				return PuzzleState[heuristicName](state, goalState);
			}
			return 0;
		}, this);
		
		// Instantiate algorithm
		var algorithm = new AlgorithmConstructor({}, {
			'initialState': initialState,
			'isGoalState': isGoalState,              // Callback
			'onDiscover': onDiscover,                // Callback
			'heuristicFunction': heuristicFunction,  // Callback
			'storeExploredStates': true,             // Only applies to DFS
		});

		// Update application state
		this.set({
			'algorithm': algorithm,
			'statistics': algorithm.getStatistics(),
			'state': algorithm.wasGoalFound() ? 'complete' : 'running'
		});
		
		// Attempt to iterate the algorithm if in burst mode
		if (config.getMode() == 'burst') {
			this.next();
		}
		
		return this;
	}
});