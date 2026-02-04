// Auto-generated from mapAMR.smap
// Do not edit manually - use generateMapConfig() to regenerate

module.exports = {
  nodes: {
    "LM2": {
        "id": "LM2",
        "x": 3.641,
        "y": -0.593
    },
    "LM3": {
        "id": "LM3",
        "x": 3.641,
        "y": -2.007
    },
    "LM4": {
        "id": "LM4",
        "x": 0.013,
        "y": -2.007
    },
    "AP5": {
        "id": "AP5",
        "x": 0.013,
        "y": -0.593
    },
    "LM5": {
        "id": "LM5",
        "x": 6.5,
        "y": -0.593
    },
    "LM6": {
        "id": "LM6",
        "x": 6.5,
        "y": -2.007
    },
    "AP6": {
        "id": "AP6",
        "x": 9,
        "y": -0.593
    },
    "AP7": {
        "id": "AP7",
        "x": 9,
        "y": -2.007
    },
    "LM7": {
        "id": "LM7",
        "x": 1.8,
        "y": 1.5
    },
    "LM8": {
        "id": "LM8",
        "x": 1.8,
        "y": -3.5
    },
    "AP8": {
        "id": "AP8",
        "x": 5,
        "y": 1.5
    },
    "AP9": {
        "id": "AP9",
        "x": 5,
        "y": -3.5
    },
    "LM9": {
        "id": "LM9",
        "x": 7.5,
        "y": 1
    },
    "LM10": {
        "id": "LM10",
        "x": 7.5,
        "y": -3
    }
},
  
  connections: {
    "LM2": [
        "AP5",
        "LM3",
        "LM5"
    ],
    "LM3": [
        "LM2",
        "LM4",
        "LM6"
    ],
    "LM5": [
        "AP6",
        "LM2",
        "LM6",
        "LM9"
    ],
    "AP5": [
        "LM2",
        "LM4",
        "LM7"
    ],
    "LM4": [
        "AP5",
        "LM3",
        "LM8"
    ],
    "LM6": [
        "AP7",
        "LM3",
        "LM5"
    ],
    "LM8": [
        "AP9",
        "LM10",
        "LM4"
    ],
    "LM7": [
        "AP5",
        "AP8",
        "LM9"
    ],
    "AP6": [
        "AP7",
        "AP8",
        "LM5"
    ],
    "LM9": [
        "AP8",
        "LM5",
        "LM7"
    ],
    "AP7": [
        "AP6",
        "LM10",
        "LM6"
    ],
    "AP8": [
        "AP6",
        "LM7",
        "LM9"
    ],
    "LM10": [
        "AP7",
        "AP9",
        "LM8"
    ],
    "AP9": [
        "LM10",
        "LM8"
    ]
}
};
